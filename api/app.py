import os
import re
import logging
import secrets

from flask import Flask, render_template, request, abort, jsonify, session
from dotenv import load_dotenv

load_dotenv(override=False)

from api.core.config import Config
from api.providers import UnifiedScraper
from api.routes.anime import anime_routes_bp, watch_routes_bp, watch_together_bp, catalog_routes_bp, anilist_api_bp, themes_api_bp
from api.routes.shared.admin_routes import admin_bp
from api.routes.manga import manga_routes_bp, manga_api_bp
from api.routes.shared import auth_bp, watchlist_bp, api_bp, home_routes_bp, search_routes_bp
from api.core.extensions import limiter
from api.utils.client_detection import is_obvious_bot_user_agent

_RE_STRIP_ANIME_ID = re.compile(r'-\d+$')

# ── Urgent Announcement Mode ──────────────────────────────────────────
# Set to True to put the entire site into maintenance mode.
# All routes will display the announcement page instead of normal content.
URGENT_ANNOUNCEMENT = False

class WerkzeugRequestFilter(logging.Filter):
    def filter(self, record):
        # Suppress HTTP access/request logs (e.g. GET /static/... HTTP/1.1)
        if "HTTP/" in record.getMessage():
            return False
        return True

def create_app():
    app = Flask(__name__, instance_relative_config=False)
    app.config.from_object(Config)

    try:
        Config.validate()
    except (AttributeError, Exception):
        pass

    if not app.config.get("SECRET_KEY"):
        env_secret = os.environ.get("FLASK_KEY") or os.environ.get("SECRET_KEY")
        if env_secret:
            app.config["SECRET_KEY"] = env_secret
        else:
            app.config["SECRET_KEY"] = secrets.token_urlsafe(64)
            app.logger.warning(
                "No SECRET_KEY set — using auto-generated key. Set FLASK_KEY in production."
            )

    log_level_name = getattr(Config, "LOG_LEVEL", None) or os.environ.get("LOG_LEVEL", "INFO")
    logging.basicConfig(level=getattr(logging, log_level_name.upper(), logging.INFO))

    # Suppress verbose third-party loggers and Werkzeug HTTP request logs
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    logging.getLogger("aiohttp").setLevel(logging.WARNING)

    # Filter out HTTP request log lines from Werkzeug, while keeping startup banner
    werkzeug_logger = logging.getLogger("werkzeug")
    werkzeug_logger.setLevel(logging.INFO)
    for f in list(werkzeug_logger.filters):
        if isinstance(f, WerkzeugRequestFilter):
            werkzeug_logger.removeFilter(f)
    werkzeug_logger.addFilter(WerkzeugRequestFilter())

    is_debug = bool(app.config.get("DEBUG") or app.debug)
    app.config.update(
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=not is_debug,
        TEMPLATES_AUTO_RELOAD=is_debug,
    )

    app.jinja_env.filters['regex_replace'] = (
        lambda s, pat, rep: re.sub(pat, rep, str(s)) if s is not None else ''
    )
    app.jinja_env.filters['strip_anime_id'] = (
        lambda s: _RE_STRIP_ANIME_ID.sub('', str(s)) if s is not None else ''
    )

    def _manga_cover_proxy(url, referer=''):
        """Proxy manga cover images through the image proxy to bypass referer restrictions."""
        if not url:
            return ''
        url = str(url) if url is not None else ''
        referer = str(referer) if referer is not None else ''
        if not url:
            return ''
            
        import hashlib
        import os
        
        # Calculate local cache filename
        h = hashlib.md5(url.encode('utf-8')).hexdigest()
        ext = 'jpg'
        if '.png' in url.lower(): ext = 'png'
        elif '.webp' in url.lower(): ext = 'webp'
        elif '.gif' in url.lower(): ext = 'gif'
        
        filename = f"{h}.{ext}"
        try:
            covers_dir = os.path.join(app.root_path, 'static', 'manga_covers')
            if os.path.exists(os.path.join(covers_dir, filename)):
                return f'/static/manga_covers/{filename}'
        except Exception:
            pass
            
        from urllib.parse import quote
        return f'/api/manga/image-proxy?url={quote(url, safe="")}&referer={quote(referer, safe="")}'

    app.jinja_env.filters['manga_cover'] = _manga_cover_proxy

    app.ha_scraper = UnifiedScraper()
    limiter.init_app(app)

    # Register blueprints
    app.register_blueprint(home_routes_bp)
    app.register_blueprint(search_routes_bp)
    app.register_blueprint(anime_routes_bp)
    app.register_blueprint(watch_routes_bp)
    app.register_blueprint(watch_together_bp)
    app.register_blueprint(catalog_routes_bp)
    app.register_blueprint(themes_api_bp)
    app.register_blueprint(manga_routes_bp)
    app.register_blueprint(auth_bp,      url_prefix='/auth')
    app.register_blueprint(watchlist_bp, url_prefix='/watchlist')
    app.register_blueprint(api_bp,       url_prefix='/api')
    app.register_blueprint(admin_bp)



    @app.context_processor
    def inject_user_role():
        """Make user_role available in all templates dynamically."""
        role = 'user'
        if '_id' in session:
            try:
                from api.core.db_connector import users_collection
                user = users_collection.find_one({"_id": session["_id"]}, {"role": 1})
                if user:
                    role = user.get("role", "user")
                    session["role"] = role
                else:
                    role = session.get('role', 'user')
            except Exception:
                role = session.get('role', 'user')
        return dict(user_role=role)

    @app.before_request
    def check_urgent_announcement():
        if not URGENT_ANNOUNCEMENT:
            return
        if request.path.startswith('/static/'):
            return
        return render_template('shared/announcement.html'), 503

    @app.before_request
    def block_obvious_bots():
        if request.path.startswith('/static/'):
            return
        ua = request.headers.get('User-Agent', '')
        if is_obvious_bot_user_agent(ua):
            app.logger.warning(f"Blocked bot UA='{ua[:80]}' PATH={request.path} IP={request.remote_addr}")
            abort(403)

    @app.before_request
    def validate_session_version():
        if request.path.startswith('/static/'):
            return
        if '_id' in session:
            from api.models.user import get_user_by_id
            user = get_user_by_id(session['_id'])
            if user:
                # If password_version in DB points to a newer login/password change,
                # invalidate the current old session.
                db_version = user.get('password_version', 0)
                session_version = session.get('password_version', 0)
                if db_version != session_version:
                    session.clear()
            else:
                session.clear()


    @app.errorhandler(404)
    def page_not_found(e):
        app.logger.warning(f"404: {request.url}")
        return render_template('shared/404.html', error_message="Page not found"), 404

    @app.after_request
    def apply_security_headers(response):
        """Apply system-wide backend hardening security headers."""
        response.headers["X-Frame-Options"] = "SAMEORIGIN"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        return response

    @app.errorhandler(500)
    def internal_server_error(e):
        app.logger.error(f"500: {e}")
        return render_template('shared/404.html', error_message="Internal server error"), 500

    @app.errorhandler(429)
    def ratelimit_handler(e):
        app.logger.warning(f"Rate limit: {request.url} — {request.remote_addr}")
        return jsonify(success=False, message="Too many attempts. Please try again later."), 429

    return app


app = create_app()

if __name__ == "__main__":
    import sys
    try:
        app.run(debug=True)
    except KeyboardInterrupt:
        print("Server gracefully stopped.")
    except OSError as e:
        if getattr(e, 'winerror', None) == 10038:
            print("Server gracefully stopped (socket released).")
        else:
            raise
    except BaseException:     
        sys.exit(0)
