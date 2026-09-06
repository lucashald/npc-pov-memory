import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {applyComfyModel} from './comfy-model.js';
const workflow=JSON.stringify({'1':{class_type:'UNETLoader',inputs:{unet_name:'old.safetensors',weight_dtype:'default'}}});
test('Workflow default preserves its exact contents',()=>assert.equal(applyComfyModel(workflow),workflow));
for(const field of ['ckpt_name','unet_name']) {
    test(`Model selection overrides a single ${field} loader`,()=>{
        const input=JSON.stringify({'1':{inputs:{[field]:'old',other:'preserve'}}});
        const result=JSON.parse(applyComfyModel(input,'new.safetensors'));
        assert.equal(result['1'].inputs[field],'new.safetensors');
        assert.equal(result['1'].inputs.other,'preserve');
    });
}
test('Explicit model placeholder targets one loader without changing a refiner',()=>{
    const input=JSON.stringify({'1':{inputs:{ckpt_name:'%model%'}},'2':{inputs:{ckpt_name:'refiner'}}});
    const result=JSON.parse(applyComfyModel(input,'model "quoted".safetensors'));
    assert.equal(result['1'].inputs.ckpt_name,'model "quoted".safetensors');
    assert.equal(result['2'].inputs.ckpt_name,'refiner');
});
test('Ambiguous and unsupported workflows reject an override',()=>{
    assert.throws(()=>applyComfyModel('{}','new'),/placeholder/);
    assert.throws(()=>applyComfyModel(JSON.stringify({'1':{inputs:{ckpt_name:'a'}},'2':{inputs:{ckpt_name:'b'}}}),'new'),/placeholder/);
});
function client(fetch){
    const box={fetch,getRequestHeaders:()=>({'Content-Type':'application/json'}),applyComfyModel};
    vm.createContext(box);
    vm.runInContext(fs.readFileSync(new URL('./comfy.js',import.meta.url),'utf8').replace(/^import .*;\r?$/gm,'').replace(/^export /gm,''),box);
    return box;
}
test('Comfy model discovery uses the SillyTavern proxy and preserves filenames',async()=>{
    const box=client(async(path,options)=>{
        assert.equal(path,'/api/sd/comfy/models');
        assert.equal(JSON.parse(options.body).url,'http://comfy:8188');
        return {ok:true,json:async()=>[{value:'model.safetensors',text:'UNet: model'}]};
    });
    const models=await box.fetchComfyModels('http://comfy:8188');
    assert.equal(models[0].value,'model.safetensors');
});
test('Render submits the selected model with substituted prompt',async()=>{
    let submitted;
    const box=client(async(path,options)=>{
        if(path.endsWith('/workflow'))return {ok:true,json:async()=>workflow};
        submitted=JSON.parse(options.body);
        return {ok:true,json:async()=>({data:'image',format:'png'})};
    });
    await box.renderImage({comfyUrl:'http://comfy:8188',workflow:'scene.json',model:'chosen.safetensors',prompt:'Scene',seed:1,steps:8,width:512,height:512});
    assert.equal(JSON.parse(submitted.prompt).prompt['1'].inputs.unet_name,'chosen.safetensors');
});
