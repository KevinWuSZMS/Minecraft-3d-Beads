import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {BeadViewer,fitDistance,bindPanelClick} from '../public/src/viewer.js';

function fixture(){
  const viewer=Object.create(BeadViewer.prototype);
  Object.assign(viewer,{colorMode:'physical',selectedPanelId:null,meshes:[],scene:new THREE.Scene(),group:new THREE.Group(),grid:new THREE.GridHelper(20,20),explode:.6,size:20});
  viewer.scene.add(viewer.group);
  viewer.scene.add(viewer.grid);
  for(const [index,hex]of ['#286942','#F8CB42'].entries()){
    const mesh=new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshStandardMaterial(),1);
    mesh.userData.panel={id:'P'+index,normal:[0,0,1]};
    mesh.position.set(index,2,5);
    mesh.setMatrixAt(0,new THREE.Matrix4().makeTranslation(index,3,4));
    mesh.setColorAt(0,new THREE.Color(hex));
    viewer.group.add(mesh);
    viewer.meshes.push(mesh);
  }
  return viewer;
}

function assertOpaque(mesh){
  assert.equal(mesh.material.opacity,1);
  assert.equal(mesh.material.transparent,false);
  assert.equal(mesh.material.depthWrite,true);
}

test('H01 gets a separate transmissive material while the complete panel outline includes clear beads',()=>{
  const viewer=Object.create(BeadViewer.prototype);
  Object.assign(viewer,{colorMode:'physical',selectedPanelId:null,meshes:[],scene:new THREE.Scene(),
    group:new THREE.Group(),grid:new THREE.GridHelper(20,20),explode:0,size:0,
    geometry:new THREE.BoxGeometry(.86,.86,.86),controls:{target:new THREE.Vector3()},fitCamera(){},preset(){}});
  viewer.scene.add(viewer.group);viewer.scene.add(viewer.grid);
  const panels=[
    {id:'MIXED',normal:[0,0,1],cells:[{p:[0,0,0],code:'H02',hex:'#FBFBFB'},
      {p:[4,0,0],code:'H01',hex:'#FFFFFF',transparent:true},{p:[7,0,0],code:'H01',hex:'#FFFFFF',transparent:true}]},
    {id:'OPAQUE',normal:[0,1,0],cells:[{p:[0,4,0],code:'B09',hex:'#2A5037'}]},
  ];
  viewer.setModel({panels,surface:panels.flatMap(panel=>panel.cells)});
  assert.equal(viewer.meshes.length,3);
  const clear=viewer.meshes.find(mesh=>mesh.userData.clearBeads);
  const solid=viewer.meshes.find(mesh=>mesh.userData.panel.id==='MIXED'&&!mesh.userData.clearBeads);
  assert.equal(clear.count,2);assert.equal(solid.count,1);
  const snapshots=viewer.meshes.map(mesh=>({mesh,matrix:mesh.instanceMatrix.array.slice(),colors:mesh.instanceColor.array.slice()}));
  for(const mode of ['physical','accurate','physical']) {
    viewer.setColorMode(mode);
    assert.equal(clear.material.type,'MeshPhysicalMaterial');
    assert.ok(clear.material.transmission>0);
    assert.equal(clear.material.opacity,1,'Transparent plastic uses transmission, not whole-panel alpha');
    for(const id of ['MIXED','OPAQUE',null,'MIXED']) {
      viewer.select(id);
      for(const {mesh,matrix,colors}of snapshots) {
        assert.deepEqual(mesh.instanceMatrix.array,matrix);
        assert.deepEqual(mesh.instanceColor.array,colors);
        assertOpaque(mesh);
        if(!mesh.userData.clearBeads) {
          assert.equal(mesh.material.type,mode==='accurate'?'MeshBasicMaterial':'MeshStandardMaterial');
          assert.equal(mesh.material.transmission||0,0);
        }
      }
      if(id==='MIXED') {
        const outline=viewer.selectionOutline;
        assert.equal(outline.parent,solid);
        const entire=new THREE.Box3().copy(solid.boundingBox).union(clear.boundingBox);
        assert.ok(outline.box.containsBox(entire),'Border must enclose both the opaque mesh and the farther clear beads');
        assert.ok(outline.box.max.x>solid.boundingBox.max.x+6,'The clear end of the face cannot be omitted from its selection border');
      }
    }
  }
  viewer.setExplode(.8);
  assert.deepEqual(clear.position,solid.position,'Clear and opaque parts of one panel explode together');
  viewer.select(null);
  for(const mesh of viewer.meshes)mesh.material.dispose();
  viewer.geometry.dispose();viewer.grid.dispose();
});

test('mode switches preserve geometry, placement, swatches and selection; old materials are disposed',()=>{
  const viewer=fixture();
  viewer.select('P0');
  assert.equal(viewer.selectedPanelId,'P0');
  viewer.meshes.forEach(assertOpaque);
  const snapshot=viewer.meshes.map(mesh=>({mesh,geometry:mesh.geometry,position:mesh.position.clone(),matrix:mesh.instanceMatrix.array.slice(),colors:mesh.instanceColor.array.slice(),panel:mesh.userData.panel}));
  let disposed=0;
  viewer.meshes.forEach(mesh=>mesh.material.addEventListener('dispose',()=>disposed++));
  viewer.setColorMode('accurate');
  assert.equal(disposed,2);
  assert.equal(viewer.colorMode,'accurate');
  assert.equal(viewer.selectedPanelId,'P0');
  viewer.meshes.forEach((mesh,index)=>{
    assert.equal(mesh,snapshot[index].mesh);
    assert.equal(mesh.geometry,snapshot[index].geometry);
    assert.deepEqual(mesh.position,snapshot[index].position);
    assert.deepEqual(mesh.instanceMatrix.array,snapshot[index].matrix);
    assert.deepEqual(mesh.instanceColor.array,snapshot[index].colors);
    assert.equal(mesh.userData.panel,snapshot[index].panel);
    assert.equal(mesh.material.type,'MeshBasicMaterial');
    assert.equal(mesh.material.toneMapped,false);
    assert.equal(mesh.material.color.getHex(),0xffffff);
    assertOpaque(mesh);
  });
  const accurateMaterials=viewer.meshes.map(mesh=>mesh.material);
  viewer.setColorMode('accurate');
  viewer.meshes.forEach((mesh,index)=>assert.equal(mesh.material,accurateMaterials[index]));
  accurateMaterials.forEach(material=>material.addEventListener('dispose',()=>disposed++));
  viewer.setColorMode('physical');
  assert.equal(disposed,4);
  assert.equal(viewer.selectedPanelId,'P0');
  viewer.meshes.forEach((mesh,index)=>{
    assert.equal(mesh.material.type,'MeshStandardMaterial');
    assert.equal(mesh.material.roughness,.82);
    assert.equal(mesh.material.metalness,0);
    assert.equal(mesh.material.emissive.getHex(),0);
    assert.equal(mesh.material.emissiveIntensity,0);
    assertOpaque(mesh);
    assert.deepEqual(mesh.instanceColor.array,snapshot[index].colors);
  });
  viewer.select(null);
  assert.equal(viewer.selectedPanelId,null);
  viewer.meshes.forEach(mesh=>{assertOpaque(mesh);mesh.material.dispose();mesh.geometry.dispose();});
});

test('selecting and clearing any panel never turns another panel translucent or changes its swatch',()=>{
  const viewer=fixture();
  const snapshots=viewer.meshes.map(mesh=>({matrix:mesh.instanceMatrix.array.slice(),colors:mesh.instanceColor.array.slice(),panel:mesh.userData.panel}));
  for(const mode of ['accurate','physical']){
    viewer.setColorMode(mode);
    for(const id of ['P0','P1',null]){
      viewer.select(id);
      assert.equal(viewer.selectedPanelId,id);
      viewer.meshes.forEach((mesh,index)=>{
        assertOpaque(mesh);
        assert.deepEqual(mesh.instanceMatrix.array,snapshots[index].matrix);
        assert.deepEqual(mesh.instanceColor.array,snapshots[index].colors);
        assert.equal(mesh.userData.panel,snapshots[index].panel);
        assert.equal(mesh.material.color.getHex(),0xffffff);
      });
    }
  }
  viewer.meshes.forEach(mesh=>{mesh.material.dispose();mesh.geometry.dispose();});
});

test('selection borders follow exploded panels, obey occlusion and are released on clear/model replacement',()=>{
  const viewer=fixture();
  viewer.fitCamera=()=>{};
  viewer.select('P0');
  const outline=viewer.selectionOutline,mesh=viewer.meshes[0];
  assert.equal(outline.parent,mesh);
  assert.equal(outline.material.depthTest,true);
  assert.equal(outline.material.depthWrite,false);
  assert.equal(outline.material.transparent,false);
  const meshBefore=mesh.position.clone();
  viewer.scene.updateMatrixWorld(true);
  const before=outline.getWorldPosition(new THREE.Vector3());
  viewer.setExplode(.8);
  viewer.scene.updateMatrixWorld(true);
  const after=outline.getWorldPosition(new THREE.Vector3());
  assert.ok(after.sub(before).distanceTo(mesh.position.clone().sub(meshBefore))<1e-9);
  let geometryDisposed=0,materialDisposed=0;
  outline.geometry.addEventListener('dispose',()=>geometryDisposed++);
  outline.material.addEventListener('dispose',()=>materialDisposed++);
  viewer.select('P0');
  assert.equal(viewer.selectionOutline,outline,'reselecting a panel does not allocate another border');
  viewer.select(null);
  assert.equal(outline.parent,null);
  assert.equal(geometryDisposed,1);
  assert.equal(materialDisposed,1);
  viewer.select('P1');
  const second=viewer.selectionOutline;
  second.geometry.addEventListener('dispose',()=>geometryDisposed++);
  second.material.addEventListener('dispose',()=>materialDisposed++);
  let resetCount=0;
  viewer.picking={reset(){resetCount++;}};
  const geometries=viewer.meshes.map(current=>current.geometry);
  viewer.setModel({surface:[],panels:[]});
  assert.equal(resetCount,1);
  assert.equal(second.parent,null);
  assert.equal(geometryDisposed,2);
  assert.equal(materialDisposed,2);
  assert.equal(viewer.selectedPanelId,null);
  assert.equal(viewer.selectionOutline,null);
  geometries.forEach(geometry=>geometry.dispose());
});

test('the floor grid stays below every actual panel while the bottom face explodes and returns',()=>{
  const viewer=fixture();
  viewer.fitCamera=()=>{};
  viewer.meshes[1].userData.panel.normal=[0,-1,0];
  const floorHeights=[];
  for(const amount of [0,.5,1,0]){
    viewer.setExplode(amount);
    viewer.scene.updateMatrixWorld(true);
    const boxes=viewer.meshes.map(mesh=>new THREE.Box3().setFromObject(mesh));
    const lowest=Math.min(...boxes.map(box=>box.min.y));
    assert.ok(viewer.grid.position.y<lowest,'the grid must not intersect or obscure the lower panel');
    floorHeights.push(viewer.grid.position.y);
  }
  assert.ok(floorHeights[1]<floorHeights[0]);
  assert.ok(floorHeights[2]<floorHeights[1]);
  assert.ok(Math.abs(floorHeights[3]-floorHeights[0])<1e-9,'closing the exploded view restores the floor position');
  viewer.meshes.forEach(mesh=>{mesh.material.dispose();mesh.geometry.dispose();});
  viewer.grid.dispose();
});

test('camera fitting accounts for portrait viewports and exploded-model radius',()=>{
  const square=fitDistance(20,1),portrait=fitDistance(20,.5),landscape=fitDistance(20,2);
  assert.ok(portrait>square);
  assert.equal(landscape,square);
  assert.ok(fitDistance(35,1)>square);
  for(const aspect of [.3,.5,1,2]){
    const distance=fitDistance(20,aspect);
    const halfFov=Math.min(THREE.MathUtils.degToRad(35)/2,Math.atan(Math.tan(THREE.MathUtils.degToRad(35)/2)*aspect));
    assert.ok(Math.asin(20/distance)<halfFov);
  }
});

function pointerHarness(t){
  const windowTarget=new EventTarget();
  const element=new EventTarget();
  element.ownerDocument={defaultView:windowTarget};
  element.getBoundingClientRect=()=>({left:0,top:0,width:500,height:500});
  const clicks=[];
  const binding=bindPanelClick(element,event=>clicks.push(event));
  t.after(()=>binding.dispose());
  function dispatch(type,properties={}){
    const event=new Event(type,{cancelable:true});
    const defaults={pointerId:1,pointerType:'mouse',button:type==='pointermove'?-1:0,buttons:type==='pointerup'?0:1,isPrimary:true,clientX:100,clientY:100,timeStamp:type==='pointerdown'?0:80};
    for(const [key,value]of Object.entries({...defaults,...properties}))Object.defineProperty(event,key,{value,configurable:true});
    element.dispatchEvent(event);
    return event;
  }
  return {dispatch,clicks,binding,windowTarget};
}

test('panel picking accepts one primary click and consumes its pointerup',t=>{
  const {dispatch,clicks}=pointerHarness(t);
  dispatch('pointerdown');
  dispatch('pointermove',{clientX:102,clientY:101,timeStamp:40});
  const up=dispatch('pointerup',{clientX:102,clientY:101});
  assert.equal(clicks.length,1);
  assert.equal(clicks[0],up);
  dispatch('pointerup');
  assert.equal(clicks.length,1,'a stale pointerup must not select twice');
});

test('right, middle and non-primary pointers never select a panel',t=>{
  const {dispatch,clicks,binding}=pointerHarness(t);
  for(const properties of [{button:2,buttons:2},{button:1,buttons:4},{isPrimary:false,pointerType:'touch'}]){
    dispatch('pointerdown',properties);
    dispatch('pointerup',{...properties,buttons:0});
    assert.equal(clicks.length,0);
    binding.reset();
  }
  dispatch('pointerdown');
  dispatch('pointerup',{pointerId:99});
  assert.equal(clicks.length,0,'a different pointer cannot finish the gesture');
});

test('dragging out and back cannot become a click; a stationary hold remains selectable',t=>{
  const {dispatch,clicks,binding}=pointerHarness(t);
  dispatch('pointerdown');
  dispatch('pointermove',{clientX:130,timeStamp:30});
  dispatch('pointermove',{clientX:100,timeStamp:60});
  dispatch('pointerup');
  assert.equal(clicks.length,0,'total gesture history, not only the final position, rejects a drag');
  binding.reset();
  dispatch('pointerdown');
  dispatch('pointerup',{timeStamp:1200});
  assert.equal(clicks.length,1,'a stationary hold retains the same primary-button behavior');
});

test('multitouch cancels selection until all contacts are released, then a new primary touch works',t=>{
  const {dispatch,clicks}=pointerHarness(t);
  dispatch('pointerdown',{pointerType:'touch'});
  dispatch('pointerdown',{pointerId:2,pointerType:'touch',isPrimary:false,timeStamp:10});
  dispatch('pointerup',{pointerId:2,pointerType:'touch',isPrimary:false,timeStamp:30});
  dispatch('pointerup',{pointerType:'touch'});
  assert.equal(clicks.length,0);
  dispatch('pointerdown',{pointerId:3,pointerType:'touch',timeStamp:200});
  dispatch('pointerup',{pointerId:3,pointerType:'touch',timeStamp:260});
  assert.equal(clicks.length,1);
});

test('cancellation, lost capture, blur and model reset discard pending picks',t=>{
  const {dispatch,clicks,binding,windowTarget}=pointerHarness(t);
  for(const cancel of [()=>dispatch('pointercancel'),()=>dispatch('lostpointercapture'),()=>windowTarget.dispatchEvent(new Event('blur')),()=>binding.reset()]){
    dispatch('pointerdown');
    cancel();
    dispatch('pointerup');
    assert.equal(clicks.length,0);
    binding.reset();
  }
});

test('unexpected mouse button states cancel a pick and disposed bindings cannot select',t=>{
  const {dispatch,clicks,binding}=pointerHarness(t);
  for(const buttons of [0,2,3]){
    dispatch('pointerdown');
    dispatch('pointermove',{buttons});
    dispatch('pointerup');
    assert.equal(clicks.length,0);
    binding.reset();
  }
  dispatch('pointerdown');
  dispatch('pointerup',{buttons:1});
  assert.equal(clicks.length,0,'pointerup must report all buttons released');
  binding.reset();
  dispatch('pointerdown');
  binding.dispose();
  dispatch('pointerup');
  dispatch('pointerdown');
  dispatch('pointerup');
  assert.equal(clicks.length,0);
});
