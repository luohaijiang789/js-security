"""Versioned wire constants and strict JSON validation; no I/O dependencies."""
import hashlib
import json
import math
import re

SCHEMA = 'capture-stream-2'
DEFAULT_CODE = 'blackbox-capture-v1'
CHUNK_BYTES = 256 * 1024
OBJECT_BYTES = 128 * 1024 * 1024
EVENT_BYTES = 128 * 1024 * 1024
HASH = re.compile(r'[a-f0-9]{64}')
PROJECT = re.compile(r'[A-Za-z0-9_-]{1,64}')
UPLOAD = re.compile(r'[A-Za-z0-9_-]{8,64}')
CATEGORIES = {'js_source', 'script_load', 'api_request', 'page_context', 'task'}


class Invalid(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def sha(data):
    return hashlib.sha256(data).hexdigest()


def strict_json(value):
    def pairs(items):
        result = {}
        for key, item in items:
            if key in result:
                raise Invalid('Duplicate JSON key.')
            result[key] = item
        return result

    def invalid_constant(value):
        raise Invalid('Non-finite JSON number.')

    def finite_float(value):
        number = float(value)
        if not math.isfinite(number):
            raise Invalid('Non-finite JSON number.')
        return number

    try:
        return json.loads(value, object_pairs_hook=pairs, parse_constant=invalid_constant, parse_float=finite_float)
    except (ValueError, UnicodeError, RecursionError) as error:
        raise Invalid('Invalid JSON.') from error

