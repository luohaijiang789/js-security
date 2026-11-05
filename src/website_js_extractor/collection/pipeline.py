"""Settle recursive collection and freeze a manifest before any API extraction."""
from collections import Counter
import json
from website_js_extractor.domain.assets import digest, http_url
from website_js_extractor.collection.fetcher import StaticFetcher, origin
from website_js_extractor.collection.graph import ReferenceGraph


def collect_assets(snapshot, engine_root, settings, *, timeout=60):
    seeds = sorted({asset.get('url') or asset['location'] for asset in snapshot.assets if asset['kind'] == 'js'})
    seed_hash = digest([(asset['id'], asset['sha256']) for asset in snapshot.assets])
    observed = {origin(value) for asset in snapshot.assets
                for value in [asset.get('url'), asset.get('page_url'), asset.get('request_base_url')]
                if http_url(value)}
    allowed = sorted(observed | set(settings.allowed_origins))
    fetcher = StaticFetcher(allowed, max_files=settings.max_fetch_files, timeout=settings.fetch_timeout,
                            deadline=settings.fetch_deadline, retries=settings.fetch_retries) if settings.fetch_js and allowed else None
    graph = ReferenceGraph(snapshot, engine_root, max_depth=settings.max_js_depth, timeout=timeout,
                           seeds=seeds, concurrency=settings.fetch_concurrency)
    graph.run(fetcher)
    states = Counter(edge['status'] for edge in graph.edges)
    unresolved = [edge['id'] for edge in graph.edges if edge['status'] != 'available'
                  and edge.get('resolution_reason') != 'non_js_module']
    manifest = dict(schema='analysis-assets-1', stage='frozen', seed_hash=seed_hash,
                    depth_basis='captured-seed-relative', seed_depth=1, max_depth=settings.max_js_depth,
                    settings=settings.document(), effective_allowed_origins=allowed,
                    status='partial' if unresolved or any(gap.get('incomplete') for gap in snapshot.gaps) else 'complete',
                    assets=[dict(id=a['id'], sha256=a['sha256'], context_id=a['context_id'], body_file=a['body_file'],
                                 bytes=a['bytes'], acquisition=a.get('acquisition'), depth=a.get('js_depth')) for a in snapshot.assets],
                    reference_statuses=dict(states), unresolved_reference_ids=unresolved,
                    gap_ids=[gap['id'] for gap in snapshot.gaps])
    manifest['manifest_hash'] = digest(manifest)
    path = snapshot.output/'analysis-manifest.json'
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)
    return manifest
