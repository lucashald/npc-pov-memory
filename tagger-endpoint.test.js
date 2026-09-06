import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taggerEndpointUrls, fetchTaggerModels } from './tagger-endpoint.js';

test('Endpoint URLs support completion URLs, base URLs, and proxy prefixes',()=>{
    for (const [input,base] of [
        ['http://localhost:1234/v1/chat/completions','http://localhost:1234/v1'],
        ['http://localhost:1234/v1/','http://localhost:1234/v1'],
        ['http://localhost:1234','http://localhost:1234/v1'],
        ['https://example.com/proxy/v1/chat/completions/','https://example.com/proxy/v1'],
        ['https://example.com/chat/completions','https://example.com'],
    ]) {
        assert.deepEqual(taggerEndpointUrls(input),{models:base+'/models',completions:base+'/chat/completions'});
    }
});

test('Endpoint URLs reject invalid protocols and preserve query parameters',()=>{
    assert.throws(()=>taggerEndpointUrls('file:///v1'));
    assert.throws(()=>taggerEndpointUrls('not a URL'));
    assert.equal(taggerEndpointUrls('https://example.com/v1/chat/completions?route=local#fragment').models,'https://example.com/v1/models?route=local');
});

test('Model discovery returns sorted unique IDs and forwards cancellation',async(t)=>{
    const controller=new AbortController();
    t.mock.method(globalThis,'fetch',async(url,options)=>{
        assert.equal(url,'http://localhost:1234/v1/models');
        assert.equal(options.signal,controller.signal);
        return {ok:true,json:async()=>({data:[{id:'z'},{id:'a'},{id:'z'},{id:4},null,{id:''}]})};
    });
    assert.deepEqual(await fetchTaggerModels('http://localhost:1234/v1',{signal:controller.signal}),['a','z']);
});

test('Model discovery reports HTTP errors',async(t)=>{
    t.mock.method(globalThis,'fetch',async()=>({ok:false,status:401}));
    await assert.rejects(fetchTaggerModels('http://localhost:1234'),/HTTP 401/);
});

test('Model discovery distinguishes empty and malformed responses',async(t)=>{
    const mock=t.mock.method(globalThis,'fetch',async()=>({ok:true,json:async()=>({data:[]})}));
    assert.deepEqual(await fetchTaggerModels('http://localhost:1234'),[]);
    mock.mock.mockImplementation(async()=>({ok:true,json:async()=>({models:[]})}));
    await assert.rejects(fetchTaggerModels('http://localhost:1234'),/data array/);
});
