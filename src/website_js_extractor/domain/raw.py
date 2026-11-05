"""Versioned raw notification validation and capture-journal manifests."""
import re
from website_js_extractor.domain.protocol import Invalid, strict_json, sha
RAW_METHODS = {'Debugger.scriptParsed', 'Runtime.executionContextCreated', 'Runtime.executionContextDestroyed',
               'Runtime.executionContextsCleared', 'Network.requestWillBeSent', 'Network.requestWillBeSentExtraInfo',
               'Network.responseReceived', 'Network.responseReceivedExtraInfo', 'Network.loadingFinished',
               'Network.loadingFailed', 'Target.attachedToTarget', 'Target.detachedFromTarget'}


def parse_raw(event):
    data = event['data']
    text = data.get('capture_json')
    if not isinstance(text, str): raise Invalid('Missing raw observation JSON.')
    raw = text.encode('utf-8')
    if type(data.get('capture_bytes')) is not int or len(raw) != data['capture_bytes'] or sha(raw) != data.get('capture_sha256'):
        raise Invalid('Raw observation checksum/length mismatch.', 422)
    observation = strict_json(text)
    if not isinstance(observation, dict): raise Invalid('Invalid raw observation.')
    connection, sequence = observation.get('connection'), observation.get('sequence')
    if not isinstance(connection, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,128}',connection) or type(sequence) is not int or not 1 <= sequence <= 2**53-1:
        raise Invalid('Invalid raw capture identity.')
    source = observation.get('source')
    if not isinstance(source, dict) or type(source.get('tabId')) is not int or source['tabId'] < 0 or (source.get('sessionId') is not None and not isinstance(source['sessionId'], str)):
        raise Invalid('Invalid raw source.')
    if not isinstance(observation.get('method'),str) or observation['method'] not in RAW_METHODS or not isinstance(observation.get('params'), dict): raise Invalid('Invalid raw notification.')
    if observation.get('capture_state') not in {'recording','paused','draining'} or type(observation.get('config_version')) is not int or observation['config_version'] < 1:
        raise Invalid('Invalid raw capture policy.')
    if observation.get('js_epoch') is not None and not isinstance(observation['js_epoch'], str): raise Invalid('Invalid raw JS epoch.')
    if event['id'] != f'raw:{connection}:{sequence}' or event.get('epoch') != connection or event.get('tab_id') != source['tabId'] or event.get('session_id') != source.get('sessionId','root') or event.get('time') != observation.get('observed_at'):
        raise Invalid('Raw observation identity does not match event.')
    return observation
