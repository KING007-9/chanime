import base64
import json

def encrypt_payload(data_dict, key):
    """Encrypts the dictionary payload using a custom XOR cipher with shifting."""
    plain_text = json.dumps(data_dict)
    key_bytes = key.encode('utf-8')
    plain_bytes = plain_text.encode('utf-8')
    encrypted = bytearray()
    
    for i, b in enumerate(plain_bytes):
        # Custom cipher: XOR with key and apply dynamic shifting
        k_byte = key_bytes[i % len(key_bytes)]
        shift = (i * 3) % 256
        val = b ^ k_byte ^ shift
        encrypted.append(val)
        
    return base64.b64encode(encrypted).decode('utf-8')

def decrypt_payload(ciphertext, key):
    """Decrypts the base64-encoded ciphertext using the key."""
    encrypted_bytes = base64.b64decode(ciphertext)
    key_bytes = key.encode('utf-8')
    decrypted = bytearray()
    
    for i, b in enumerate(encrypted_bytes):
        k_byte = key_bytes[i % len(key_bytes)]
        shift = (i * 3) % 256
        val = b ^ k_byte ^ shift
        decrypted.append(val)
        
    return json.loads(decrypted.decode('utf-8'))

def obfuscate_key(key):
    """Obfuscates the cipher key for safe transmission in HTML templates."""
    reversed_key = key[::-1]
    return base64.b64encode(reversed_key.encode('utf-8')).decode('utf-8')
