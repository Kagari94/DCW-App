const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const express = require('express');
const sharp = require('sharp');
const { createCharacterStore } = require('../server/lib/characters');
const { createSettingsStore } = require('../server/settings');
const { createOutfitTools } = require('../server/tools/handlers/outfits');
const { withCharacterContext } = require('../server/lib/toolCallLoop');
const { runToolLoop } = require('../server/lib/toolLoop');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-outfits-'));
    const charactersDir = path.join(root, 'characters');fs.mkdirSync(charactersDir);
    fs.writeFileSync(path.join(charactersDir, 'base.vrm'), 'original-model');
    const characters = createCharacterStore({ charactersDir });
    const character = characters.createCharacter({ name: 'Hsin', legacyFile: 'base.vrm', personality: 'Curious and kind.',
        voice: { backend: 'kokoro', kokoro: 'af_nova', pocket: '' } });
    const settings = createSettingsStore({ settingsPath: path.join(root, 'settings.json'), characters });
    settings.updateSettings({ currentCharacter: character.id });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    function add(name='Winter') {
        const outfitId=randomUUID(),directory=characters.outfitDirectoryFor(character.id,outfitId);
        fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'model.vrm'),'outfit-model');
        characters.addOutfit(character.id,{name,outfitId,originalName:'Winter.vrm'});
        return outfitId;
    }
    return {root,charactersDir,characters,character,settings,add};
}

test('outfits persist under one companion while its identity, voice and conversation scope stay fixed', t => {
    const {characters,character,settings,add,charactersDir}=fixture(t);
    assert.equal(character.activeOutfit,'default');assert.equal(character.outfits.length,1);
    const id=add();const selected=characters.selectOutfit(character.id,id);
    assert.equal(selected.id,character.id);assert.equal(selected.name,character.name);
    assert.equal(selected.personality,character.personality);assert.deepEqual(selected.voice,character.voice);
    assert.match(selected.modelUrl,new RegExp(`/outfits/${id}/model.vrm$`));
    assert.equal(settings.getSettings().currentCharacter,character.id);
    assert.equal(settings.getSettings().character.activeOutfit,id);
    characters.updateCharacter(character.id,{personality:'Still kind.'});
    assert.equal(characters.readCharacter(character.id).activeOutfit,id);
    const context=withCharacterContext([{role:'system',content:'Companion.'}],character.id,characters.readCharacter);
    assert.match(context[0].content,/Current outfit: Winter/);
    assert.equal(characters.selectOutfit(character.id,'default').modelUrl,character.modelUrl);
    assert.equal(fs.readFileSync(path.join(charactersDir,'base.vrm'),'utf8'),'original-model');
});

test('missing outfit files fall back to the original model; IDs and image metadata cannot escape folders', t => {
    const {characters,character,add}=fixture(t);const id=add();
    characters.selectOutfit(character.id,id);
    fs.unlinkSync(path.join(characters.outfitDirectoryFor(character.id,id),'model.vrm'));
    assert.equal(characters.readCharacter(character.id).activeOutfit,'default');
    assert.equal(characters.listCharacters().find(item=>item.id===character.id).modelUrl,character.modelUrl);
    assert.throws(()=>characters.selectOutfit(character.id,id),{status:400});
    assert.throws(()=>characters.outfitDirectoryFor(character.id,'../outside'),{status:400});
    assert.throws(()=>characters.selectOutfit(character.id,'../outside'),{status:400});
    assert.throws(()=>characters.updateOutfit(character.id,'default',{image:'../../outside.png'}),{status:400});
    assert.equal(characters.readCharacter(character.id).outfits[0].imageUrl,null);
});

test('AI tools change only the active companion and issue the existing UI event without disturbing chat', async t => {
    const {characters,character,settings,add}=fixture(t);const id=add();
    const tools=createOutfitTools({characters,getSettings:settings.getSettings});
    const config=settings.getSettings();
    assert.equal(tools.handlers.list_outfits({},config).outfits.length,2);
    const messages=[{role:'system',content:'Companion.'},{role:'user',content:'Wear winter clothes.'}];
    let calls=0;
    const result=await runToolLoop(messages,config,null,{toolHandlers:tools.handlers,callModel:async()=>++calls===1
        ? {role:'assistant',content:null,tool_calls:[{id:'change',function:{name:'change_outfit',arguments:JSON.stringify({outfit_id:id})}}]}
        : {role:'assistant',content:'I changed into Winter.'}});
    assert.equal(characters.readCharacter(character.id).activeOutfit,id);
    assert.deepEqual(result.uiEvents,[{window:'outfits',action:'change',characterId:character.id}]);
    assert.equal(messages[1].content,'Wear winter clothes.');assert.equal(settings.getSettings().currentCharacter,character.id);
    settings.updateSettings({currentCharacter:'base.vrm'});
    assert.throws(()=>tools.handlers.change_outfit({outfit_id:'default'},config),/Selected companion changed/);
    assert.equal(characters.readCharacter(character.id).activeOutfit,id);
});

test('multipart VRMs and both thumbnail types save and reload, while invalid files leave profiles intact', async t => {
    const {characters,character,charactersDir}=fixture(t);
    const app=express();app.use(express.json());app.use(require('../server/routes/outfits').makeRouter({characters}));
    const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
    const base=`http://127.0.0.1:${server.address().port}/characters/${character.id}`;
    async function upload(url,field,bytes,filename,fields={}) {
        const body=new FormData();body.append(field,new Blob([bytes]),filename);
        for(const [key,value] of Object.entries(fields)) body.append(key,value);
        return fetch(url,{method:'POST',body});
    }
    const uploaded=await upload(`${base}/outfits/upload`,'vrm',Buffer.from('new-vrm'),'Formal.vrm',{name:'Formal'});
    const uploadResult=await uploaded.json();
    assert.equal(uploaded.status,201,JSON.stringify(uploadResult));
    const created=uploadResult.character;const outfit=created.outfits.find(item=>item.name==='Formal');
    assert.equal(fs.readFileSync(path.join(characters.outfitDirectoryFor(character.id,outfit.id),'model.vrm'),'utf8'),'new-vrm');
    const selected=await fetch(`${base}/outfits/${outfit.id}/select`,{method:'POST'});
    assert.equal((await selected.json()).character.activeOutfit,outfit.id);
    const png=await sharp({create:{width:800,height:400,channels:3,background:'red'}}).png().toBuffer();
    for(const endpoint of [`${base}/image`,`${base}/outfits/${outfit.id}/image`]) {
        const response=await upload(endpoint,'image',png,'preview.png');assert.equal(response.status,200);
        const updated=(await response.json()).character;
        const imageUrl=endpoint.endsWith(`${character.id}/image`) ? updated.imageUrl : updated.outfits.find(item=>item.id===outfit.id).imageUrl;
        assert.match(imageUrl,/preview\.webp\?v=/);
        const relative=decodeURIComponent(imageUrl.split('/models/characters/')[1].split('?')[0]);
        const metadata=await sharp(fs.readFileSync(path.join(charactersDir,relative))).metadata();
        assert.equal(metadata.format,'webp');assert.equal(metadata.width,384);assert.equal(metadata.height,192);
        assert.equal((await upload(endpoint,'image',Buffer.from('bad'),'bad.png')).status,400);
        assert.equal(characters.readCharacter(character.id).activeOutfit,outfit.id);
    }
    assert.equal((await upload(`${base}/outfits/upload`,'vrm',Buffer.from('bad'),'bad.exe')).status,400);
    assert.equal((await fetch(`${base}/outfits/${randomUUID()}/select`,{method:'POST'})).status,400);
    assert.equal((await fetch(base.replace(character.id,randomUUID())+'/outfits')).status,404);
});
