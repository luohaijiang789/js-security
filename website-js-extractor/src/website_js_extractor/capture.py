"""Frozen browser-source input. Never execute code or fetch supplied URLs."""
import json
from .assets import digest, http_url

MAX_CAPTURE_BYTES = 12*1024*1024
MAX_UPLOAD_BYTES = 20*1024*1024


def capture_context(value):
    if not isinstance(value, dict) or value.get('type') not in {'page', 'unknown'}:
        raise ValueError('Invalid browser execution context.')
    page, base = value.get('page_url'), value.get('request_base_url')
    if value['type'] == 'unknown':
        if page is not None or base is not None:
            raise ValueError('Unknown contexts cannot supply an inferred request base.')
    elif not http_url(page) or base is not None and not http_url(base):
        raise ValueError('Invalid browser document/base URL.')
    return dict(type=value['type'], page_url=page, request_base_url=base,
                evidence='browser_capture_context' if base else 'capture_base_unknown')


def validate_capture(value):
    if not isinstance(value, dict) or value.get('schema_version') != 'capture-0.1':
        raise ValueError('Expected capture-0.1 snapshot.')
    for key in ('snapshot_id', 'task_id'):
        if not isinstance(value.get(key), str) or not 1 <= len(value[key]) <= 100:
            raise ValueError('Invalid snapshot/task identity.')
    assets = value.get('assets')
    if not isinstance(assets, list) or not 1 <= len(assets) <= 300:
        raise ValueError('Snapshot needs 1–300 complete JS assets.')
    total = 0
    contexts = {}
    for asset in assets:
        if not isinstance(asset, dict) or not isinstance(asset.get('content'), str):
            raise ValueError('Snapshot asset needs a complete textual source.')
        body = asset['content'].encode('utf-8')
        total += len(body)
        if len(body) > 2*1024*1024 or total > MAX_CAPTURE_BYTES:
            raise ValueError('Browser snapshot exceeds body budget; partial bodies are not accepted.')
        if asset.get('sha256') != digest(body):
            raise ValueError('Browser asset SHA256 mismatch.')
        if asset.get('url') is not None and not http_url(asset['url']):
            raise ValueError('Unsupported script URL; preserve anonymous/blob source with url=null.')
        if not isinstance(asset.get('context_key'), str) or not 1 <= len(asset['context_key']) <= 300:
            raise ValueError('Invalid browser context identity.')
        context = capture_context(asset.get('context'))
        key = asset['context_key']
        if key in contexts and contexts[key] != context:
            raise ValueError('Conflicting browser execution contexts.')
        contexts[key] = context
    gaps = value.get('gaps', [])
    if not isinstance(gaps, list) or len(gaps) > 201:
        raise ValueError('Invalid capture gap list.')
    for gap in gaps:
        if not isinstance(gap, dict) or not isinstance(gap.get('kind'), str) or not isinstance(gap.get('message'), str):
            raise ValueError('Invalid capture gap.')
    return value


def import_capture(snapshot, source):
    if source.stat().st_size > MAX_UPLOAD_BYTES:
        raise ValueError('Capture input exceeds upload budget.')
    value = validate_capture(json.loads(source.read_text(encoding='utf-8')))
    for index, item in enumerate(value['assets']):
        context = capture_context(item['context'])
        asset = snapshot.add(item['content'].encode('utf-8'), location=f'capture/{index}.js',
                             url=item.get('url'), page_url=context['page_url'], kind='js',
                             context_key=[value['task_id'], item['context_key']],
                             observation={'source':'browser-parsed-script', 'snapshot_id':value['snapshot_id'],
                                          'capture_url':item.get('capture_url'), 'script_id':item.get('script_id')})
        if asset:
            asset['capture_context'] = context
    # The browser prototype is a partial observation even when no individual read failed.
    snapshot.gap('browser_capture_scope', 'Only observed parsed scripts were supplied; missing/unloaded code and parent depths may be unknown.', incomplete=True)
    for gap in value.get('gaps', []):
        snapshot.gap('capture_'+gap['kind'][:100], gap['message'][:2000], source=str(gap.get('source', ''))[:4096], incomplete=True)
