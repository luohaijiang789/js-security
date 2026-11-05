"""Validated analysis policy shared by task, HTTP, CLI and collection stages."""
from dataclasses import asdict, dataclass
from urllib.parse import urlsplit


@dataclass(frozen=True)
class AnalysisSettings:
    max_js_depth: int = 5
    fetch_js: bool = True
    allowed_origins: tuple[str, ...] = ()
    max_fetch_files: int = 100
    fetch_concurrency: int = 4
    fetch_timeout: float = 10
    fetch_deadline: float = 60
    fetch_retries: int = 1

    @classmethod
    def parse(cls, value=None):
        if value is None: value = {}
        if not isinstance(value, dict) or set(value) - set(cls.__dataclass_fields__):
            raise ValueError('Unknown/invalid analysis configuration.')
        data = asdict(cls())
        data.update(value)
        for name, minimum, maximum in [('max_js_depth', 1, 32), ('max_fetch_files', 1, 10000),
                                       ('fetch_concurrency', 1, 32), ('fetch_retries', 0, 5)]:
            if type(data[name]) is not int or not minimum <= data[name] <= maximum:
                raise ValueError(f'{name} must be an integer in {minimum}..{maximum}.')
        if type(data['fetch_js']) is not bool: raise ValueError('fetch_js must be boolean.')
        for name in ['fetch_timeout', 'fetch_deadline']:
            if type(data[name]) not in (int, float) or not 0 < data[name] <= 600:
                raise ValueError(f'{name} must be a finite timeout in (0,600].')
        origins = data['allowed_origins']
        if not isinstance(origins, (list, tuple)) or len(origins) > 100:
            raise ValueError('allowed_origins must be a list with at most 100 origins.')
        clean = []
        for value in origins:
            if not isinstance(value, str): raise ValueError('Invalid allowed origin.')
            parsed = urlsplit(value)
            try: parsed.port
            except ValueError: raise ValueError('Invalid allowed origin port.')
            if parsed.scheme not in {'http','https'} or not parsed.hostname or parsed.username or parsed.password or parsed.path not in {'','/'} or parsed.query or parsed.fragment or any(c.isspace() for c in value):
                raise ValueError('allowed_origins accepts exact HTTP(S) origins, without paths or credentials.')
            clean.append(value.rstrip('/'))
        data['allowed_origins'] = tuple(sorted(set(clean)))
        return cls(**data)

    def document(self):
        value = asdict(self)
        value['allowed_origins'] = list(self.allowed_origins)
        return value
