import * as THREE from 'three';
import {OrbitControls} from '../vendor/OrbitControls.js';

const COLOR_MODES=new Set(['accurate','physical']);

// OrbitControls owns pointer capture. Observe the whole gesture without
// interfering with rotation/panning, and consume each candidate only once.
export function bindPanelClick(element,onClick){
  const pointers=new Set();
  let candidate=null;
  const reset=()=>{candidate=null;pointers.clear();};
  const move=event=>{
    if(!candidate||event.pointerId!==candidate.id)return;
    if(Math.hypot(event.clientX-candidate.x,event.clientY-candidate.y)>5
      ||(event.pointerType==='mouse'&&event.buttons!==1))candidate=null;
  };
  const handlers={
    pointerdown(event){
      pointers.add(event.pointerId);
      if(pointers.size!==1||event.button!==0||event.isPrimary===false){candidate=null;return;}
      candidate={id:event.pointerId,x:event.clientX,y:event.clientY};
    },
    pointermove:move,
    pointerup(event){
      const click=candidate;
      candidate=null;
      pointers.delete(event.pointerId);
      if(click&&click.id===event.pointerId&&event.button===0&&event.buttons===0
        &&event.isPrimary!==false&&pointers.size===0
        &&Math.hypot(event.clientX-click.x,event.clientY-click.y)<=5)onClick(event);
    },
    pointercancel:reset,
    lostpointercapture:reset,
  };
  for(const [name,handler]of Object.entries(handlers))element.addEventListener(name,handler);
  const ownerWindow=element.ownerDocument?.defaultView;
  ownerWindow?.addEventListener('blur',reset);
  return {reset,dispose(){
    reset();
    for(const [name,handler]of Object.entries(handlers))element.removeEventListener(name,handler);
    ownerWindow?.removeEventListener('blur',reset);
  }};
}

// The unlit swatch path only multiplies white by the exact MARD instance color.
function createMaterial(mode,clear=false){
  const common={color:0xffffff,toneMapped:false};
  // H01 is clear plastic, not a white swatch. Transmission is reserved for
  // these beads; normal faces remain opaque even when selected.
  if(clear)return new THREE.MeshPhysicalMaterial({...common,roughness:.18,metalness:0,
    transmission:.88,thickness:.86,ior:1.45,transparent:false,opacity:1,depthWrite:true});
  return mode==='physical'
    ?new THREE.MeshStandardMaterial({...common,roughness:.82,metalness:0,emissive:0x000000,emissiveIntensity:0})
    :new THREE.MeshBasicMaterial(common);
}

export function fitDistance(radius,aspect,fov=35){
  const vertical=THREE.MathUtils.degToRad(fov)/2;
  const horizontal=Math.atan(Math.tan(vertical)*Math.max(.05,aspect));
  return Math.max(18,Math.max(1,radius)*1.12/Math.sin(Math.min(vertical,horizontal)));
}

export class BeadViewer{
  constructor(host,onSelect){
    this.host=host;
    this.onSelect=onSelect;
    this.colorMode='accurate';
    this.selectedPanelId=null;
    this.scene=new THREE.Scene();
    this.scene.background=new THREE.Color('#f2f3ed');
    this.camera=new THREE.PerspectiveCamera(35,1,.1,2000);
    this.renderer=new THREE.WebGLRenderer({antialias:true,alpha:false});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio,2));
    this.renderer.outputColorSpace=THREE.SRGBColorSpace;
    this.renderer.toneMapping=THREE.NoToneMapping;
    this.renderer.setClearColor('#f2f3ed');
    host.append(this.renderer.domElement);
    this.controls=new OrbitControls(this.camera,this.renderer.domElement);
    this.controls.enableDamping=true;
    this.controls.dampingFactor=.08;
    this.controls.maxDistance=700;
    this.controls.minDistance=4;

    // All physical-preview lights are white, with no colored fill or ground.
    this.scene.add(new THREE.HemisphereLight(0xffffff,0xffffff,1.4));
    const key=new THREE.DirectionalLight(0xffffff,1.1);
    key.position.set(35,60,40);
    this.scene.add(key);
    const fill=new THREE.DirectionalLight(0xffffff,.35);
    fill.position.set(-30,10,-20);
    this.scene.add(fill);

    this.group=new THREE.Group();
    this.scene.add(this.group);
    this.meshes=[];
    this.explode=0;
    this.size=20;
    const shape=new THREE.Shape();
    shape.absarc(0,0,.475,0,Math.PI*2,false);
    const hole=new THREE.Path();
    hole.absarc(0,0,.18,0,Math.PI*2,true);
    shape.holes.push(hole);
    this.geometry=new THREE.ExtrudeGeometry(shape,{depth:.86,bevelEnabled:true,bevelSegments:1,steps:1,bevelSize:.035,bevelThickness:.035,curveSegments:8});
    this.geometry.translate(0,0,-.43);
    this.grid=new THREE.GridHelper(100,50,'#d8ddd2','#e4e7de');
    this.scene.add(this.grid);
    this.resize=new ResizeObserver(()=>{
      const rect=host.getBoundingClientRect();
      if(rect.width<1||rect.height<1)return;
      this.camera.aspect=rect.width/rect.height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(rect.width,rect.height);
      if(this.meshes.length)this.fitCamera(true);
    });
    this.resize.observe(host);
    this.running=true;
    const frame=()=>{
      if(!this.running)return;
      requestAnimationFrame(frame);
      this.controls.update();
      this.renderer.render(this.scene,this.camera);
    };
    frame();
    this.picking=bindPanelClick(this.renderer.domElement,event=>{
      const rect=this.renderer.domElement.getBoundingClientRect(),ray=new THREE.Raycaster();
      if(rect.width<1||rect.height<1||event.clientX<rect.left||event.clientX>=rect.right
        ||event.clientY<rect.top||event.clientY>=rect.bottom)return;
      ray.setFromCamera(new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1),this.camera);
      this.group.updateMatrixWorld(true);
      // The selection border is decoration, never a pickable model surface.
      const hit=ray.intersectObjects(this.meshes,false)[0];
      if(hit)this.onSelect?.(hit.object.userData.panel.id);
    });
  }

  setColorMode(mode){
    if(!COLOR_MODES.has(mode))throw new RangeError('Unknown bead color mode: '+mode);
    if(this.colorMode===mode)return;
    this.colorMode=mode;
    for(const mesh of this.meshes){
      const previous=mesh.material;
      mesh.material=createMaterial(mode,mesh.userData.clearBeads);
      previous.dispose();
    }
    this.select(this.selectedPanelId);
  }

  setModel(result){
    this.picking?.reset();
    this.select(null);
    for(const mesh of this.meshes){this.group.remove(mesh);mesh.material.dispose();}
    this.meshes=[];
    this.selectedPanelId=null;
    const bounds=new THREE.Box3();
    result.surface.forEach(cell=>bounds.expandByPoint(new THREE.Vector3(...cell.p)));
    if(bounds.isEmpty())return;
    const center=bounds.getCenter(new THREE.Vector3());
    this.size=bounds.getSize(new THREE.Vector3()).length();
    const dummy=new THREE.Object3D();
    for(const panel of result.panels){
      for(const clear of [false,true]){
      const cells=panel.cells.filter(cell=>Boolean(cell.transparent||cell.code==='H01')===clear);
      if(!cells.length)continue;
      const mesh=new THREE.InstancedMesh(this.geometry,createMaterial(this.colorMode,clear),cells.length);
      mesh.userData.panel=panel;
      mesh.userData.clearBeads=clear;
      const quaternion=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,1),new THREE.Vector3(...panel.normal));
      cells.forEach((cell,index)=>{
        dummy.position.set(...cell.p).sub(center);
        dummy.quaternion.copy(quaternion);
        dummy.updateMatrix();
        mesh.setMatrixAt(index,dummy.matrix);
        mesh.setColorAt(index,new THREE.Color(cell.hex));
      });
      mesh.instanceMatrix.needsUpdate=true;
      if(mesh.instanceColor)mesh.instanceColor.needsUpdate=true;
      mesh.computeBoundingSphere();
      mesh.computeBoundingBox();
      this.group.add(mesh);
      this.meshes.push(mesh);
      }
    }
    this.grid.position.y=bounds.min.y-center.y-.65;
    this.grid.scale.setScalar(Math.max(1,this.size/70));
    this.grid.visible=result.patternMode!=='faces';
    this.controls.target.set(0,0,0);
    this.setExplode(this.explode);
    this.preset(result.patternMode==='faces'||result.flat?'front':'iso');
  }

  explosionDistance(){return this.explode*Math.max(5,this.size*.22);}

  fitCamera(onlyExpand=false){
    const distance=fitDistance(this.size/2+1+this.explosionDistance(),this.camera.aspect,this.camera.fov);
    const offset=this.camera.position.clone().sub(this.controls.target);
    if(offset.lengthSq()<.0001)offset.set(.8,.57,.9);
    if(!onlyExpand||offset.length()<distance){
      offset.setLength(distance);
      this.camera.position.copy(this.controls.target).add(offset);
    }
    this.controls.maxDistance=Math.max(700,distance*3);
    this.camera.far=Math.max(2000,distance*5);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  setExplode(value){
    const next=Number(value);
    this.explode=Number.isFinite(next)?Math.max(0,next):0;
    for(const mesh of this.meshes)mesh.position.set(...mesh.userData.panel.normal).multiplyScalar(this.explosionDistance());
    if(this.grid&&this.meshes.length){
      const bottom=Math.min(...this.meshes.map(mesh=>{
        if(!mesh.boundingBox)mesh.computeBoundingBox();
        return mesh.boundingBox.min.y+mesh.position.y;
      }));
      // The floor must follow the lowest expanded face instead of cutting
      // through its beads and drawing grid lines over the model.
      this.grid.position.y=bottom-.16;
    }
    if(this.meshes.length)this.fitCamera(true);
  }

  select(id){
    const selected=this.meshes.find(mesh=>mesh.userData.panel.id===id);
    this.selectedPanelId=selected? id:null;
    for(const mesh of this.meshes){
      if(mesh.material.transparent)mesh.material.needsUpdate=true;
      mesh.material.opacity=1;
      mesh.material.transparent=false;
      mesh.material.depthWrite=true;
    }
    if(selected&&this.selectionOutline?.parent===selected)return;
    if(this.selectionOutline){
      this.selectionOutline.removeFromParent();
      this.selectionOutline.geometry.dispose();
      this.selectionOutline.material.dispose();
      this.selectionOutline=null;
    }
    if(!selected)return;
    const bounds=new THREE.Box3();
    for(const mesh of this.meshes.filter(mesh=>mesh.userData.panel.id===id)){
      mesh.computeBoundingBox();
      bounds.union(mesh.boundingBox);
    }
    const outline=new THREE.Box3Helper(bounds.expandByScalar(.07),0xb58a3b);
    outline.material.depthTest=true;
    outline.material.depthWrite=false;
    outline.material.transparent=false;
    outline.material.toneMapped=false;
    // Keep normal occlusion: the border must never show through another face.
    outline.renderOrder=1;
    selected.add(outline);
    this.selectionOutline=outline;
  }

  preset(type){
    const direction=type==='front'?[0,.0001,1]:type==='top'?[.0001,1,0]:[.8,.57,.9];
    this.camera.position.copy(this.controls.target).add(new THREE.Vector3(...direction));
    this.fitCamera();
  }

  screenshot(){
    this.renderer.render(this.scene,this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
}
