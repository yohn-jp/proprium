import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPairedPreferenceOverride, type PairedPreferenceSnapshot } from './preference-settings-panel.js';
const snapshot:PairedPreferenceSnapshot = {
 workspace:{settings:{defaultPresetId:'a',featurePresetIds:{rewrite:'a'}}},
 effective:{defaultPresetId:'b',presets:[{id:'a',label:'A',model:'local/a'},{id:'b',label:'B',model:'local/b'}],featurePresetIds:{rewrite:'b'}},
 local:{defaultPresetId:'b',featurePresetIds:{rewrite:'b',futureFeature:'a'},totalCuBudget:4},
};
test('local override changes one feature while preserving unrelated preferences',()=>{
 const result=buildPairedPreferenceOverride(snapshot,'b',{rewrite:'a'});
 assert.deepEqual(result,{defaultPresetId:'b',featurePresetIds:{rewrite:'a',futureFeature:'a'},totalCuBudget:4});
 assert.deepEqual(snapshot.local.featurePresetIds,{rewrite:'b',futureFeature:'a'});
});
test('inheriting removes local selections without copying workspace defaults',()=>{
 const result=buildPairedPreferenceOverride(snapshot,'',{});
 assert.deepEqual(result,{featurePresetIds:{futureFeature:'a'},totalCuBudget:4});
});
test('unknown preset references fail before save',()=>{
 assert.throws(()=>buildPairedPreferenceOverride(snapshot,'not-a-preset',{}),/プリセット/u);
 assert.throws(()=>buildPairedPreferenceOverride(snapshot,'a',{rewrite:'not-a-preset'}),/プリセット/u);
});
