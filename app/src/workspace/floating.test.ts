import assert from "node:assert/strict";
import { test } from "node:test";
import { floatingStorageKey, validateFloatingPanels, loadFloatingPanels, saveFloatingPanels } from "./floating";
const ids=["editor","outline","inspector"],hidden=["outline"];
const example=[{panelId:"outline",left:100,top:120,width:350,height:390}];
test("floating layout validates identity, visibility, geometry and duplicates",()=>{
 assert.equal(validateFloatingPanels(example,ids,hidden),true);
 assert.equal(validateFloatingPanels(example,ids,[]),false);
 assert.equal(validateFloatingPanels([{...example[0],panelId:"foreign"}],ids,hidden),false);
 assert.equal(validateFloatingPanels([{...example[0],width:0}],ids,hidden),false);
 assert.equal(validateFloatingPanels([example[0],example[0]],ids,hidden),false);
});
test("floating layout is scoped and invalid saved data falls back without deletion",()=>{
 const values=new Map<string,string>();
 const store={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
 assert.equal(saveFloatingPanels(store,"author",example,ids,hidden),true);
 assert.deepEqual(loadFloatingPanels(store,"author",ids,hidden),example);
 assert.deepEqual(loadFloatingPanels(store,"someone-else",ids,hidden),[]);
 values.set(floatingStorageKey("author"),"not-json");
 assert.deepEqual(loadFloatingPanels(store,"author",ids,hidden),[]);
 assert.equal(values.get(floatingStorageKey("author")),"not-json");
});
