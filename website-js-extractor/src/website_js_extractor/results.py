"""Lossless engine-record references plus conservative candidate previews."""
import csv
import json
import re
from urllib.parse import parse_qsl, urljoin, urlsplit

from .assets import digest, http_url

PAGE_RELATIVE = {'fetch', 'XHR.open', 'sendBeacon', 'Request', 'axios', 'EventSource', 'WebSocket'}


def leaves(value, prefix=''):
    if not isinstance(value, dict):
        return []
    result = []
    for name, expression in value.items():
        path = prefix+'.'+str(name) if prefix else str(name)
        if isinstance(expression, dict) and expression:
            result.extend(leaves(expression, path))
        else:
            result.append((path, expression))
    return result


def parameter_rows(record):
    fields = []
    query = record.get('query_schema')
    if isinstance(query, dict):
        fields.extend(('Query', name, value, 'query_schema') for name, value in leaves(query))
    elif isinstance(query, list):
        fields.extend(('Query', row['name'], row, 'query_schema') for row in query if isinstance(row, dict) and isinstance(row.get('name'), str))
    else:
        try:
            fields.extend(('Query', key, value, 'template') for key, value in parse_qsl(urlsplit(record.get('template', '')).query, keep_blank_values=True))
        except ValueError:
            pass
    body = record.get('body_schema') or record.get('body_shape')
    if isinstance(body, dict):
        fields.extend(('Body', name, value, 'body_schema_or_shape') for name, value in leaves(body))
    known = {name for carrier, name, _, _ in fields if carrier == 'Body'}
    for name in record.get('body_keys') or []:
        if isinstance(name, str) and name not in known and not any(x.startswith(name+'.') for x in known):
            fields.append(('Body', name, None, 'body_keys'))
    headers = record.get('req_headers')
    if isinstance(headers, dict):
        fields.extend(('Header', name, value, 'req_headers') for name, value in headers.items())
    for name in re.findall(r'\{param:([a-zA-Z_]\w*)\}', str(record.get('template', '')).split('?')[0]):
        fields.append(('Path', name, None, 'template_parameter'))
    return [dict(carrier=carrier, path=name, expression=expression, evidence=evidence,
                 value_status='unknown' if expression is None else 'engine_expression')
            for carrier, name, expression, evidence in fields]


def build_candidates(snapshot, records):
    assets = {asset['id']: asset for asset in snapshot.assets}
    candidates, other = [], []
    for envelope in records:
        record = envelope['raw']
        if record.get('_kind') not in (None, 'endpoint') or not isinstance(record.get('template'), str) or not record.get('sink'):
            other.append(envelope['id'])
            if record.get('_kind') in {'relay', 'gql-operation'} or record.get('rpc'):
                snapshot.gap('operation_adapter_pending', 'GraphQL/RPC operation is retained in raw evidence but not yet mapped into request previews.', asset_id=envelope['asset_id'])
            continue
        asset = assets.get(envelope['asset_id'])
        url = record['template']
        page = asset.get('request_base_url', asset.get('page_url')) if asset else None
        if page and (record['sink'] in PAGE_RELATIVE or record.get('via_fetch')) and not url.startswith('{'):
            # Only resolve known browser-relative sending semantics, never a CDN fallback.
            url = urljoin(page, url)
        request_id = 'candidate-'+digest([envelope['id'], envelope['asset_id'], url])[:20]
        host = path = None
        try:
            parsed = urlsplit(url)
            path = parsed.path
            if http_url(url) and not any(ch in parsed.netloc for ch in '{}[]'):
                # [] in a literal IPv6 hostname is valid; handle it without interpreting slots.
                host = parsed.scheme+'://'+parsed.netloc
            elif http_url(url) and parsed.hostname and ':' in parsed.hostname and '{' not in parsed.netloc:
                host = parsed.scheme+'://'+parsed.netloc
        except ValueError:
            snapshot.gap('request_url_unknown', 'Cannot parse engine URL expression.', request_id=request_id)
        method = record.get('method')
        if not isinstance(method, str) or method not in {'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE'}:
            method = None
        candidate = dict(id=request_id, source='site-js-static', engine_record_id=envelope['id'],
                         asset_id=envelope['asset_id'], context_id=asset['context_id'] if asset else None,
                         js_depth=asset.get('js_depth') if asset else None,
                         url=url, url_expression=record['template'], host=host, path=path, method=method,
                         sink=record['sink'], evidence_status='file-level' if asset else 'unmapped',
                         confidence='candidate', send_site=None, call_context=None,
                         parameters=parameter_rows(record), parameter_status='partial_or_unknown',
                         conditions=record.get('condition'), engine_group=envelope['group'])
        candidates.append(candidate)
        snapshot.gap('precise_location_unavailable', 'Upstream record may be merged; original send position and call context are not available.', asset_id=envelope['asset_id'], request_id=request_id)
        if not asset:
            snapshot.gap('source_unmapped', 'Could not associate engine file with an imported asset.', request_id=request_id, incomplete=True)
        if not host:
            snapshot.gap('host_unknown', 'No verified absolute Host or execution base for this expression.', request_id=request_id)
    groups = {}
    for candidate in candidates:
        # First milestone deliberately groups only concrete, known addresses.
        if not candidate['host'] or not candidate['method'] or not candidate['path'] or '{' in candidate['url'] or '}' in candidate['url']:
            continue
        key = (candidate['context_id'], candidate['engine_group'], candidate['host'], candidate['method'], candidate['path'])
        group = groups.setdefault(key, dict(id='preview-'+digest(key)[:20], rule_version='0.1-concrete-candidate',
                                           context_id=candidate['context_id'], host=candidate['host'],
                                           method=candidate['method'], path=candidate['path'], members=[]))
        group['members'].append(candidate['id'])
    return candidates, list(groups.values()), other


def safe_cell(value):
    if value is None:
        return ''
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    # Protect spreadsheet applications even when a formula has leading whitespace.
    if text.lstrip().startswith(('=', '+', '-', '@')) or text.startswith(('\t', '\r', '\n')):
        return "'"+text
    return text


def write_csv(path, columns, rows):
    with path.open('w', encoding='utf-8-sig', newline='') as handle:
        writer = csv.writer(handle)
        writer.writerow(columns)
        for row in rows:
            writer.writerow([safe_cell(row.get(column)) for column in columns])


def write_report(output, report, records):
    (output/'engine-records.json').write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding='utf-8')
    (output/'analysis.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    write_csv(output/'candidates.csv', ['id', 'url', 'host', 'method', 'asset_id', 'confidence', 'evidence_status', 'engine_record_id'], report['candidates'])
    fields = [dict(request_id=candidate['id'], **field) for candidate in report['candidates'] for field in candidate['parameters']]
    write_csv(output/'parameters.csv', ['request_id', 'carrier', 'path', 'expression', 'evidence', 'value_status'], fields)
    write_csv(output/'assets.csv', ['id', 'url', 'location', 'sha256', 'context_id', 'page_url', 'body_file', 'analysis_status', 'js_depth', 'acquisition', 'fetched_at', 'reference_url'], report['assets'])
    write_csv(output/'references.csv', ['id', 'parent_asset_id', 'context_id', 'target_context_id', 'kind', 'confidence', 'target', 'target_url', 'target_location', 'child_asset_ids', 'child_depth', 'status', 'line', 'column', 'resolution_base', 'resolution_basis', 'resolution_reason'], report.get('reference_edges', []))
    write_csv(output/'gaps.csv', ['id', 'kind', 'asset_id', 'request_id', 'source', 'message', 'incomplete'], report['gaps'])
