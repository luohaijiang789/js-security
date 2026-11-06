"""Versioned raw notification validation and capture-journal manifests."""
import re
from website_js_extractor.domain.protocol import Invalid, strict_json, sha
RAW_METHODS = {'Debugger.scriptParsed', 'Runtime.executionContextCreated', 'Runtime.executionContextDestroyed',
               'Runtime.executionContextsCleared', 'Network.requestWillBeSent', 'Network.requestWillBeSentExtraInfo',
               'Network.responseReceived', 'Network.responseReceivedExtraInfo', 'Network.loadingFinished',
               'Network.loadingFailed', 'Target.attachedToTarget', 'Target.detachedFromTarget'}
COMMAND_METHODS = {'Network.getRequestPostData', 'Network.getResponseBody', 'Debugger.getScriptSource', 'Debugger.getStackTrace'}
RAW_KINDS = {'RawCdpEvent', 'RawCdpCommandStarted', 'RawCdpCommandResult'}


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
    command = observation.get('command')
    if not isinstance(observation.get('method'),str): raise Invalid('Invalid raw method.')
    if event.get('kind') == 'RawCdpEvent':
        if command is not None or observation.get('method') not in RAW_METHODS: raise Invalid('Invalid raw notification.')
    elif event.get('kind') in RAW_KINDS:
        phase = 'started' if event['kind']=='RawCdpCommandStarted' else 'result'
        if (not isinstance(command,dict) or command.get('phase')!=phase
            or not isinstance(command.get('command_id'),str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,128}',command['command_id'])
            or not isinstance(command.get('binding'),dict) or observation.get('method') not in COMMAND_METHODS):
            raise Invalid('Invalid raw command identity.')
        if phase=='started' and ('error' in command or command.get('result') is not None): raise Invalid('Command intent contains a result.')
        if phase=='result' and (('error' in command)==('result' in command) or ('error' in command and not isinstance(command['error'],str)) or ('result' in command and not isinstance(command['result'],dict))):
            raise Invalid('Invalid raw command result.')
        binding=command['binding']
        if 'context_valid' in command and type(command['context_valid']) is not bool: raise Invalid('Invalid command context validity.')
        for field in ['request_id','source_event_id','js_epoch','target_id','observed_tab_url','received_at']:
            if binding.get(field) is not None and not isinstance(binding[field],str): raise Invalid('Invalid command binding.')
        if binding.get('script') is not None and not isinstance(binding['script'],dict): raise Invalid('Invalid script binding.')
    else: raise Invalid('Invalid raw kind.')
    if not isinstance(observation.get('params'), dict): raise Invalid('Invalid raw parameters.')
    if command:
        params=observation['params'];method=observation['method']
        if method.startswith('Network.') and not isinstance(params.get('requestId'),str): raise Invalid('Invalid command request ID.')
        if method=='Debugger.getScriptSource' and not isinstance(params.get('scriptId'),str): raise Invalid('Invalid command script ID.')
        if method=='Debugger.getStackTrace' and (not isinstance(params.get('stackTraceId'),dict) or not isinstance(params['stackTraceId'].get('id'),str)):
            raise Invalid('Invalid command stack ID.')
    if observation.get('capture_state') not in {'recording','paused','draining'} or type(observation.get('config_version')) is not int or observation['config_version'] < 1:
        raise Invalid('Invalid raw capture policy.')
    if observation.get('js_epoch') is not None and not isinstance(observation['js_epoch'], str): raise Invalid('Invalid raw JS epoch.')
    if event['id'] != f'raw:{connection}:{sequence}' or event.get('epoch') != connection or event.get('tab_id') != source['tabId'] or event.get('session_id') != source.get('sessionId','root') or event.get('time') != observation.get('observed_at'):
        raise Invalid('Raw observation identity does not match event.')
    return observation
