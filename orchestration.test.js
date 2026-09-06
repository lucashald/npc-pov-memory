import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as helpers from './gmscreen.js';

// Run the actual orchestration with SillyTavern's external services mocked.
const source = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?;\r?$/gm, '')
    .replace(/^export /gm, '');
function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}
function harness() {
    let current;
    const writes = [];
    const notices = [];
    const card = {name:'NPC',avatar:'npc.png',data:{extensions:{}}};
    const makeChat = (id, messages = [{mes:'original',name:'NPC',swipe_id:0,swipes:['original','alternate']}]) => ({
        chatId:id, characterId:0, name1:'User', characters:[card], chat:messages,
        saveChat:async()=>{},
        writeExtensionField:async(id,key,value)=>{writes.push(value);card.data.extensions[key]=value;},
    });
    current = makeChat('A');
    const box = {
        ...helpers, getContext:()=>current, extension_settings:{},
        group_activation_strategy:{POOLED:0,NATURAL:1,MANUAL:2},
        extension_prompt_types:{IN_PROMPT:0}, extension_prompt_roles:{SYSTEM:0},
        jQuery:()=>{}, console, updateMessageBlock:()=>{}, removeReasoningFromString:t=>t,
        toastr:Object.fromEntries(['info','warning','error','success','clear'].map(k=>[k,(...args)=>notices.push([k,...args])])),
    };
    vm.createContext(box);
    vm.runInContext(source,box);
    vm.runInContext('refreshSettingsPanel = () => {};',box);
    return {box,writes,notices,card,makeChat,get current(){return current;},set current(v){current=v;}};
}

test('Undo never restores another chat and retains that chat’s snapshot', async()=>{
    const h=harness(), a=h.current;
    await h.box.applyBulkChanges([{index:0,newText:'rewritten'}]);
    h.current=h.makeChat('B');
    await h.box.undoLastBulkChange();
    assert.equal(h.current.chat[0].mes,'original');
    h.current=a;
    await h.box.undoLastBulkChange();
    assert.equal(a.chat[0].mes,'original');
});

test('Undo refuses to discard newer messages or edits', async()=>{
    for (const mutate of [chat=>chat.push({mes:'new'}),chat=>{chat[0].mes='edited';}]) {
        const h=harness();
        await h.box.applyBulkChanges([{index:0,newText:'rewritten'}]);
        mutate(h.current.chat);
        const before=JSON.stringify(h.current.chat);
        await h.box.undoLastBulkChange();
        assert.equal(JSON.stringify(h.current.chat),before);
    }
});

test('Undo supports consecutive bulk operations and active swipes',async()=>{
    const h=harness();
    await h.box.applyBulkChanges([{index:0,newText:'first'}]);
    await h.box.applyBulkChanges([{index:0,newText:'second'}]);
    await h.box.undoLastBulkChange();
    assert.equal(h.current.chat[0].mes,'first');
    await h.box.undoLastBulkChange();
    assert.equal(h.current.chat[0].mes,'original');
    assert.deepEqual(Array.from(h.current.chat[0].swipes),['original','alternate']);
});

test('Memory checkpoints only supplied messages and includes later arrivals next time',async()=>{
    const h=harness(), pending=deferred(), prompts=[];
    h.box.generateMemoryUpdate=async(system,user)=>{prompts.push(user);return pending.promise;};
    const running=h.box.maybeUpdateMemory(0,{force:true});
    h.current.chat.push({mes:'new arrival',name:'NPC'});
    pending.resolve({autobiography:'summary'});
    assert.equal(await running,true);
    const key=h.box.getChatKey();
    assert.equal(h.writes[0].autobiography.lastMessageIndexByChat[key],0);
    assert.ok(!prompts[0].includes('new arrival'));
    await h.box.maybeUpdateMemory(0,{force:true});
    assert.ok(prompts[1].includes('new arrival'));
    assert.equal(h.writes[1].autobiography.lastMessageIndexByChat[key],1);
});

for (const kind of ['text','swipe','chat','card','notes']) {
    test(`Memory discards results after ${kind} changes`,async()=>{
        const h=harness(), pending=deferred();
        h.box.generateMemoryUpdate=()=>pending.promise;
        const running=h.box.maybeUpdateMemory(0,{force:true});
        if(kind==='text')h.current.chat[0].mes='edited';
        if(kind==='swipe')h.current.chat[0].swipe_id=1;
        if(kind==='chat')h.current=h.makeChat('B');
        if(kind==='card')h.current.characters=[{...h.card}];
        if(kind==='notes')h.card.data.extensions.npcPovMemory={secrets:{text:'manual secret'}};
        pending.resolve({autobiography:'stale'});
        assert.equal(await running,false);
        assert.equal(h.writes.length,0);
    });
}

for (const kind of ['text','swipe','replace','append','chat']) {
    test(`Rewrite rejects ${kind} conflicts without adding Undo`,async()=>{
        const h=harness(), pending=deferred();
        h.box.generateRewrittenMessage=()=>pending.promise;
        const running=h.box.runBulkRewrite({scope:{mode:'all'},instruction:'revise'});
        if(kind==='text')h.current.chat[0].mes='user edit';
        if(kind==='swipe')h.current.chat[0].swipe_id=1;
        if(kind==='replace')h.current.chat[0]={...h.current.chat[0]};
        if(kind==='append')h.current.chat.push({mes:'new'});
        if(kind==='chat')h.current=h.makeChat('B');
        const before=JSON.stringify(h.current.chat);
        pending.resolve('stale rewrite');
        await running;
        assert.equal(JSON.stringify(h.current.chat),before);
        assert.equal(h.box.currentUndoIndex(),-1);
    });
}

test('Rewrite succeeds, updates only active swipe, and can be undone',async()=>{
    const h=harness();
    h.box.generateRewrittenMessage=async()=> 'revised';
    await h.box.runBulkRewrite({scope:{mode:'all'},instruction:'revise'});
    assert.equal(h.current.chat[0].mes,'revised');
    assert.equal(h.current.chat[0].swipes[0],'revised');
    assert.equal(h.current.chat[0].swipes[1],'alternate');
    await h.box.undoLastBulkChange();
    assert.equal(h.current.chat[0].mes,'original');
});

test('Undo is blocked during a pending rewrite',async()=>{
    const h=harness(), pending=deferred();
    await h.box.applyBulkChanges([{index:0,newText:'first'}]);
    h.box.generateRewrittenMessage=()=>pending.promise;
    const running=h.box.runBulkRewrite({scope:{mode:'all'}});
    await h.box.undoLastBulkChange();
    assert.equal(h.current.chat[0].mes,'first');
    pending.resolve('second');
    await running;
    assert.equal(h.current.chat[0].mes,'second');
});

test('Bracket strip rejects a chat switch while confirmation is pending',async()=>{
    const h=harness(), pending=deferred();
    h.current.chat[0].mes='Scene [secret]';
    h.box.POPUP_TYPE={CONFIRM:1};
    h.box.POPUP_RESULT={AFFIRMATIVE:1};
    h.box.callGenericPopup=()=>pending.promise;
    const running=h.box.runPersistBracketStrip();
    h.current=h.makeChat('B',[{mes:'Other [secret]'}]);
    pending.resolve(1);
    await running;
    assert.equal(h.current.chat[0].mes,'Other [secret]');
    assert.equal(h.box.currentUndoIndex(),-1);
});

test('Bracket strip deletes tag-only messages and Undo restores them',async()=>{
    const h=harness();
    h.current.chat=[{mes:'Scene [secret]'},{mes:'[hidden]'}];
    h.box.POPUP_TYPE={CONFIRM:1};
    h.box.POPUP_RESULT={AFFIRMATIVE:1};
    h.box.callGenericPopup=async()=>1;
    await h.box.runPersistBracketStrip();
    assert.equal(h.current.chat.length,1);
    assert.equal(h.current.chat[0].mes,'Scene');
    await h.box.undoLastBulkChange();
    assert.equal(h.current.chat.length,2);
    assert.equal(h.current.chat[1].mes,'[hidden]');
});

test('Rewrite checks chat identity even when the message array is reused',async()=>{
    const h=harness(), pending=deferred();
    h.box.generateRewrittenMessage=()=>pending.promise;
    const running=h.box.runBulkRewrite({scope:{mode:'all'}});
    h.current.chatId='B';
    pending.resolve('stale');
    await running;
    assert.equal(h.current.chat[0].mes,'original');
});

test('Rejected memory update leaves existing relationships untouched',async()=>{
    const h=harness(), pending=deferred();
    h.card.data.extensions.npcPovMemory={relationships:{}};
    h.box.generateMemoryUpdate=()=>pending.promise;
    const running=h.box.maybeUpdateMemory(0,{force:true});
    h.current.chat[0].mes='edited';
    pending.resolve({relationship:'stale'});
    await running;
    assert.deepEqual(h.card.data.extensions.npcPovMemory.relationships,{});
});

test('Single-character tools expose shared actions and hide group-only actions',()=>{
    const h=harness();
    const labels=Array.from(h.box.buildNpcMenuItems(0),item=>item.label);
    for(const label of ['Generate image','Set portrait from chat image','View memory summary','Update memory now','Rewrite history…','Strip GM brackets from history','Undo last bulk change']) {
        assert.ok(labels.includes(label),label);
    }
    for(const label of ['Focus this speaker','Bulk roles (group)','Add character to group','Remove from group']) {
        assert.ok(!labels.includes(label),label);
    }
    assert.equal(h.box.getToolsCharacters()[0].id,0);
});

test('Group tools retain group actions and include disabled members for management',()=>{
    const h=harness();
    h.current.groupId='group';
    h.current.groups=[{id:'group',members:['npc.png'],disabled_members:['npc.png']}];
    const labels=Array.from(h.box.buildNpcMenuItems(0),item=>item.label);
    for(const label of ['Focus this speaker','Bulk roles (group)','Add character to group','Remove from group'])assert.ok(labels.includes(label),label);
    assert.equal(h.box.getToolsCharacters()[0].disabled,true);
});

test('No active character or an empty group exposes no tool targets',()=>{
    const h=harness();
    for(const id of [null,undefined,'']) {
        h.current.characterId=id;
        assert.equal(h.box.getToolsCharacters().length,0);
        assert.equal(h.box.getCharacterById(id),null);
    }
    h.current.characterId=0;
    h.current.groupId='empty';
    h.current.groups=[{id:'empty',members:[]}];
    assert.equal(h.box.getToolsCharacters().length,0);
});
