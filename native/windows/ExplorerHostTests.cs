using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

internal static class ExplorerHostTests {
    static int count;
    static void Check(bool ok,string label){if(!ok)throw new Exception(label);count++;}
    static void Refuse(Action action,string code){try{action();throw new Exception("Accepted "+code);}catch(InvalidOperationException e){Check(e.Message==code,code+": "+e.Message);}}
    static IDictionary<string,object> Message(string action,string id,string nonce,string file){return new Dictionary<string,object>{{"action",action},{"directoryId",id},{"nonce",nonce},{"filename",file}};}
    static int Main(string[] args){
        try {
            var home=Path.GetFullPath(args[0]);Directory.CreateDirectory(home);
            string root=Path.Combine(home,"destination"),parent=Path.Combine(root,"x","author","video");Directory.CreateDirectory(parent);
            var filename="x/author/video/video (1).mp4";File.WriteAllText(Path.Combine(parent,"video (1).mp4"),"fixture");
            const string origin="chrome-extension://fephnmogbbknehendbbghphieklnfnkf/",token="0123456789abcdef0123456789abcdef",id="directory-test";
            File.WriteAllText(Path.Combine(home,"MediaLatchExplorer.json"),new JavaScriptSerializer().Serialize(new { allowed_origins=new[]{origin},default_root=root }));
            var launches=new List<string>();Func<string,string> choose=name=>{throw new Exception("Unexpected picker");};
            Action<string> launch=p=>launches.Add(p);
            Check((bool)ExplorerHost.Handle(Message("status",id,token,filename),origin,home,choose,launch)["success"],"status");
            Refuse(()=>ExplorerHost.Handle(Message("status",id,token,filename),"chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",home,choose,launch),"FORBIDDEN");
            Refuse(()=>ExplorerHost.Handle(Message("execute",id,token,filename),origin,home,choose,launch),"INVALID_ACTION");
            Refuse(()=>ExplorerHost.Handle(Message("reveal",id,token,filename),origin,home,choose,launch),"DIRECTORY_LINK_REQUIRED");
            var proof=Path.Combine(root,".medialatch-explorer-"+token+".tmp");File.WriteAllText(proof,token,new UTF8Encoding(false));
            ExplorerHost.Handle(Message("reveal",id,token,filename),origin,home,choose,launch);Check(launches.Count==1 && launches[0]==parent,"exact collision file parent");
            Check(File.Exists(Path.Combine(parent,"video (1).mp4")),"file retained");
            foreach(var path in new[]{"../escape.mp4","x/../escape.mp4","C:\\outside.mp4","/escape.mp4","x//a.mp4","x/author./a.mp4","x/CON/a.mp4","x/a\".mp4"})Refuse(()=>ExplorerHost.Handle(Message("reveal",id,token,path),origin,home,choose,launch),"INVALID_PATH");
            Refuse(()=>ExplorerHost.Handle(Message("reveal",id,token,"x/missing.mp4"),origin,home,choose,launch),"FILE_NOT_FOUND");Check(launches.Count==1,"no invalid launch");
            File.Delete(proof);Refuse(()=>ExplorerHost.Handle(Message("reveal",id,token,filename),origin,home,choose,launch),"DIRECTORY_LINK_REQUIRED");
            var newRoot=Path.Combine(home,"second");Directory.CreateDirectory(newRoot);File.WriteAllText(Path.Combine(newRoot,Path.GetFileName(proof)),token,new UTF8Encoding(false));
            ExplorerHost.Handle(Message("link","directory-second",token,null),origin,home,name=>newRoot,launch);Check(launches.Count==1,"link never launches media or Explorer");
            Refuse(()=>ExplorerHost.Read(new MemoryStream(new byte[]{1,0})),"INVALID_MESSAGE");
            Refuse(()=>ExplorerHost.Read(new MemoryStream(BitConverter.GetBytes((uint)ExplorerHost.MaxMessage+1))),"INVALID_MESSAGE");
            Refuse(()=>ExplorerHost.Read(new MemoryStream(new byte[]{3,0,0,0,1})),"INVALID_MESSAGE");
            Check(ExplorerHost.Read(new MemoryStream())==null,"empty EOF");
            Console.WriteLine("PASS "+count+" native host origin/proof/path/parent/recovery/frame checks; launch intercepted");return 0;
        }catch(Exception e){Console.Error.WriteLine(e.Message);return 1;}
    }
}
