import re


BLOCKED_USER_AGENT_PATTERNS = [
    r"\bheadless(?:chrome)?\b",
    r"\bphantomjs?\b",
    r"\bselenium\b",
    r"\bpuppeteer\b",
    r"\bplaywright\b",
    r"\bwpdt\b",
    r"\bwebdriver\b",
    r"\bpython-requests\b",
    r"\bgo-http-client\b",
    r"\bcurl\b",
    r"\bwget\b",
    r"\bscrapy\b",
    r"\bhttpclient\b",
    r"\blibwww\b",
    r"\bjakarta\b",
    r"\bhttpx\b",
]


def is_obvious_bot_user_agent(user_agent):
    """Return True only for clearly automated or non-browser user agents."""
    ua = (user_agent or "").strip().lower()
    if not ua:
        return True
    return any(re.search(pattern, ua) for pattern in BLOCKED_USER_AGENT_PATTERNS)
