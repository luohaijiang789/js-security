import json
from pathlib import Path
import subprocess
import unittest

ROOT=Path(__file__).resolve().parents[1]
SCRIPT=ROOT/'src/website_js_extractor/analysis/sites.js'
BABEL=ROOT/'references/repos/jshound/jshound/js/babel.js'


class SendSiteTest(unittest.TestCase):
    def sites(self,source):
        program="const fs=require('fs'),b=require(process.argv[1]),collect=require(process.argv[2]);const s=fs.readFileSync(0,'utf8');process.stdout.write(JSON.stringify(collect(b.parser.parse(s,{sourceType:'module'}),s,b)));"
        result=subprocess.run(['node','-e',program,str(BABEL),str(SCRIPT)],input=source,text=True,capture_output=True,check=True)
        return json.loads(result.stdout)

    def test_precise_ranges_use_utf16_and_lexical_function_without_claiming_call_chain(self):
        source="const text='字😀';\nfunction load(){ return fetch('/api/items',{method:'POST',body:JSON.stringify({id:0})}); }"
        site=self.sites(source)[0]
        self.assertEqual(site['method'],'POST');self.assertEqual(site['line'],2)
        self.assertEqual(site['lexical_context']['name'],'load')
        encoded=source.encode('utf-16-le')
        self.assertEqual(encoded[site['start']*2:site['end']*2].decode('utf-16-le'),site['excerpt'])

    def test_shadowed_fetch_dynamic_options_and_non_network_methods_have_no_binding_proof(self):
        source="""function fake(fetch){ fetch('/api/fake'); }
        const local={get(x){return x;}}; local.get('/api/local');
        fetch('/api/spread',{...options});fetch('/api/method',{method:verb});
        function beacon(navigator){navigator.sendBeacon('/api/fake','x');}
        """
        self.assertEqual(self.sites(source),[])

    def test_imported_client_binding_and_duplicate_calls_keep_separate_sites(self):
        source="""import http from 'axios';
        http.post('/api/client',{zero:0});
        function first(){fetch('/api/repeated');}
        function second(){fetch('/api/repeated');}
        navigator.sendBeacon('/api/metrics','data');"""
        sites=self.sites(source)
        self.assertEqual(len(sites),4)
        self.assertEqual(sites[0]['binding'],'axios-default-import')
        self.assertEqual([site['lexical_context']['name'] for site in sites if site['template']=='/api/repeated'],['first','second'])

    def test_long_unicode_excerpt_does_not_split_a_surrogate_pair(self):
        source="fetch('/api', {body:'"+"😀"*1500+"'});"
        site=self.sites(source)[0]
        site['excerpt'].encode('utf-8')
        self.assertTrue(site['excerpt_truncated'])
        self.assertEqual(source.encode('utf-16-le')[site['start']*2:site['excerpt_end']*2].decode('utf-16-le'),site['excerpt'])
