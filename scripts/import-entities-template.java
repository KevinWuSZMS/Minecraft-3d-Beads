import java.util.*;
import java.util.function.Supplier;
import java.lang.reflect.*;
import java.nio.file.*;
import com.google.gson.GsonBuilder;
import org.joml.Matrix4f;
import net.minecraft.client.model.geom.PartPose;
import net.minecraft.client.model.geom.builders.*;
/*IMPORTS*/

/** Executes only static mesh constructors; never creates Minecraft or a window. */
public class ExportEntityModels {
  /*METHODS*/
  static final CubeDeformation OUTER_ARMOR_DEFORMATION = new CubeDeformation(1);
  static final CubeDeformation INNER_ARMOR_DEFORMATION = new CubeDeformation(.5f);
  static final CubeDeformation FISH_PATTERN_DEFORMATION = new CubeDeformation(.008f);
  static Map<String,Object> models=new TreeMap<>(), failures=new TreeMap<>();
  static String activeLayer="";
  static Object get(Object o,String field) throws Exception {
    Class<?> c=o.getClass();
    while(c!=null){try{Field f=c.getDeclaredField(field);f.setAccessible(true);return f.get(o);}catch(NoSuchFieldException e){c=c.getSuperclass();}}
    throw new NoSuchFieldException(field);
  }
  static float number(Object o,String f)throws Exception{return ((Number)get(o,f)).floatValue();}
  static float[] vector(Object o)throws Exception{return new float[]{number(o,"x"),number(o,"y"),number(o,"z")};}
  static Map<String,Object> map(Object... values){Map<String,Object> m=new LinkedHashMap<>();for(int i=0;i<values.length;i+=2)m.put((String)values[i],values[i+1]);return m;}
  static void capture(String name,Supplier<LayerDefinition> factory){
    try {
      LayerDefinition layer=factory.get();
      Object material=get(layer,"material");
      int width=((Number)get(material,"xTexSize")).intValue(),height=((Number)get(material,"yTexSize")).intValue();
      Object mesh=get(layer,"mesh"),root=mesh.getClass().getMethod("getRoot").invoke(mesh);
      List<Object> elements=new ArrayList<>();
      activeLayer=name;
      // Convert Minecraft model coordinates (Y down) to a right-handed Y-up scene.
      Matrix4f rootMatrix=new Matrix4f().scale(1,-1,-1);
      walk(root,"root",rootMatrix,elements,width,height);
      models.put(name,map("textureWidth",width,"textureHeight",height,"coordinateSystem","y-up","elements",elements));
    }catch(Throwable e){failures.put(name,e.getClass().getSimpleName()+": "+e.getMessage());}
  }
  static void walk(Object part,String path,Matrix4f parent,List<Object> elements,int width,int height)throws Exception{
    Object pose=get(part,"partPose");
    float px=number(pose,"x"),py=number(pose,"y"),pz=number(pose,"z"),xr=number(pose,"xRot"),yr=number(pose,"yRot"),zr=number(pose,"zRot");
    String name=path.substring(path.lastIndexOf('/')+1);
    // Neutral standing constants copied from the local vanilla prepareMobModel/setupAnim methods.
    // They are needed because these particular classes assign their base pose during animation.
    if(activeLayer.startsWith("cat#")||activeLayer.startsWith("ocelot#")){
      if(name.equals("body"))xr=(float)Math.PI/2;
      if(name.equals("tail1"))xr=.9f;
      if(name.equals("tail2"))xr=1.7278761f;
    }
    if(activeLayer.startsWith("wolf#")||activeLayer.startsWith("wolf_armor#")){
      if(name.equals("body")){px=0;py=14;pz=2;xr=(float)Math.PI/2;}
      if(name.equals("upper_body")){px=-1;py=14;pz=-3;xr=(float)Math.PI/2;}
      if(name.equals("tail")){px=-1;py=12;pz=8;xr=(float)Math.PI/5;}
    }
    if(activeLayer.startsWith("fox#")){
      if(name.equals("body")){px=0;py=16;pz=-6;xr=(float)Math.PI/2;zr=0;}
      if(name.equals("head")){px=-1;py=16.5f;pz=-3;yr=0;zr=0;}
      if(name.equals("tail"))xr=-.05235988f;
    }
    if((activeLayer.startsWith("spider#")||activeLayer.startsWith("cave_spider#"))&&name.endsWith("leg")){
      boolean left=name.startsWith("left");boolean middle=name.contains("middle");boolean hind=name.contains("hind");
      zr=(left?1:-1)*(middle?.58119464f:(float)Math.PI/4);
      yr=(left?-1:1)*(hind?1:-1)*(float)Math.PI/(middle?8:4);
    }
    if(activeLayer.equals("book#main")){
      if(name.equals("left_lid"))yr=(float)Math.PI+1.25f;
      if(name.equals("right_lid"))yr=-1.25f;
      if(name.equals("left_pages"))yr=1.25f;
      if(name.equals("right_pages"))yr=-1.25f;
      if(name.equals("flip_page1"))yr=1.0f;
      if(name.equals("flip_page2"))yr=-1.0f;
      if(name.endsWith("pages")||name.startsWith("flip_page"))px=(float)Math.sin(1.25);
    }
    Matrix4f world=new Matrix4f(parent).translate(px,py,pz).rotateZ(zr).rotateY(yr).rotateX(xr);
    float[] matrix=new float[16];world.get(matrix);
    int index=0;
    for(Object cube:(List<?>)get(part,"cubes")){
      float[] from=vector(get(cube,"origin")),dims=vector(get(cube,"dimensions"));
      Object grow=get(cube,"grow");float gx=number(grow,"growX"),gy=number(grow,"growY"),gz=number(grow,"growZ");
      float[] to={from[0]+dims[0]+gx,from[1]+dims[1]+gy,from[2]+dims[2]+gz};from[0]-=gx;from[1]-=gy;from[2]-=gz;
      Object baked=cube.getClass().getMethod("bake",int.class,int.class).invoke(cube,width,height);
      Object[] polygons=(Object[])get(baked,"polygons");
      List<Object> surfaces=new ArrayList<>();
      for(Object polygon:polygons){
        if(polygon==null)continue;
        List<Object> vertices=new ArrayList<>();
        for(Object vertex:(Object[])get(polygon,"vertices")){
          float[] xyz=vector(get(vertex,"pos"));
          vertices.add(map("position",xyz,"uv",new float[]{number(vertex,"u"),number(vertex,"v")}));
        }
        surfaces.add(map("normal",vector(get(polygon,"normal")),"vertices",vertices));
      }
      Object tex=get(cube,"texCoord");
      elements.add(map("name",path+"/"+(index++),"from",from,"to",to,"transform",matrix.clone(),"uvOrigin",new float[]{number(tex,"u"),number(tex,"v")},"dimensions",dims,"mirror",get(cube,"mirror"),"surfaces",surfaces));
    }
    Map<?,?> children=(Map<?,?>)get(part,"children");
    for(Object key:new TreeSet<>(children.keySet().stream().map(Object::toString).toList()))walk(children.get(key),path+"/"+key,world,elements,width,height);
  }
  public static void main(String[] args)throws Exception{
    /*CALLS*/
    Files.writeString(Path.of(args[0]),new GsonBuilder().create().toJson(map("models",models,"failures",failures)));
    System.out.println("Exported "+models.size()+" model layers; failed "+failures.size());
    for(var e:failures.entrySet())System.out.println(e.getKey()+" "+e.getValue());
  }
}

