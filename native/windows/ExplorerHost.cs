// MediaLatch Explorer companion, GPL-3.0-only. No network or general command execution.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class ExplorerHost {
    internal const int MaxMessage = 65536;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = MaxMessage, RecursionLimit = 8 };
    internal static string Text(IDictionary<string,object> data,string key) { object value; return data.TryGetValue(key,out value) ? value as string : null; }
    internal static void Require(bool ok,string code) { if(!ok)throw new InvalidOperationException(code); }
    internal static bool Id(string value) { return value!=null && Regex.IsMatch(value,@"\Adirectory-[a-zA-Z0-9-]{1,80}\z"); }
    internal static bool Token(string value) { return value!=null && Regex.IsMatch(value,@"\A[a-f0-9]{32}\z"); }
    internal static string RootPath(string root) {
        Require(root!=null && root.Length<=1024 && Regex.IsMatch(root,@"\A[A-Za-z]:\\"),"INVALID_PATH");
        var full=Path.GetFullPath(root).TrimEnd('\\');
        Require(full.Length>3 && Directory.Exists(full),"DIRECTORY_LINK_REQUIRED");
        var current=full;
        while(current!=null) { Require((File.GetAttributes(current)&FileAttributes.ReparsePoint)==0,"INVALID_PATH"); current=Path.GetDirectoryName(current); }
        return full;
    }
    internal static string FilePath(string root,string relative) {
        root=RootPath(root);
        Require(relative!=null && relative.Length>0 && relative.Length<=240,"INVALID_PATH");
        var current=root;
        foreach(var part in relative.Split('/')) {
            Require(part.Length>0 && part!="." && part!=".." && part==part.TrimEnd(' ','.') && part.IndexOfAny(Path.GetInvalidFileNameChars())<0 && !Regex.IsMatch(part,@"\A(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|\z)",RegexOptions.IgnoreCase),"INVALID_PATH");
            current=Path.Combine(current,part);
            if(Directory.Exists(current) || File.Exists(current))Require((File.GetAttributes(current)&FileAttributes.ReparsePoint)==0,"INVALID_PATH");
        }
        var full=Path.GetFullPath(current);
        Require(full.StartsWith(root+"\\",StringComparison.OrdinalIgnoreCase),"INVALID_PATH");
        Require(File.Exists(full),"FILE_NOT_FOUND");
        return full;
    }
    internal static bool Proof(string root,string token) {
        try {
            root=RootPath(root);if(!Token(token))return false;
            var proof=Path.Combine(root,".medialatch-explorer-"+token+".tmp");
            if(!File.Exists(proof) || (File.GetAttributes(proof)&FileAttributes.ReparsePoint)!=0 || new FileInfo(proof).Length!=32)return false;
            return File.ReadAllText(proof,Encoding.UTF8)==token;
        } catch { return false; }
    }
    internal static IDictionary<string,object> ReadJson(string file) {
        if(!File.Exists(file))return new Dictionary<string,object>();
        Require(new FileInfo(file).Length<=MaxMessage,"NATIVE_STORAGE_FAILED");
        return Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(file,Encoding.UTF8));
    }
    internal static void Save(string file,IDictionary<string,object> data) {
        var temp=file+".tmp";File.WriteAllText(temp,Json.Serialize(data),new UTF8Encoding(false));
        if(File.Exists(file))File.Replace(temp,file,null);else File.Move(temp,file);
    }
    internal static FileStream Lock(string file) {
        for(int n=0;n<50;n++)try{return new FileStream(file,FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);}catch(IOException){Thread.Sleep(50);}
        throw new InvalidOperationException("NATIVE_STORAGE_FAILED");
    }
    internal static IDictionary<string,object> Handle(IDictionary<string,object> message,string origin,string home,Func<string,string> choose,Action<string> reveal) {
        Require(Regex.IsMatch(origin??"",@"\Achrome-extension://[a-p]{32}/\z"),"FORBIDDEN");
        var manifest=ReadJson(Path.Combine(home,"MediaLatchExplorer.json"));object raw;
        Require(manifest.TryGetValue("allowed_origins",out raw) && raw is IList,"FORBIDDEN");
        Require(((IList)raw).Contains(origin),"FORBIDDEN");
        var action=Text(message,"action");
        Require(action=="status" || action=="link" || action=="reveal","INVALID_ACTION");
        if(action=="status")return new Dictionary<string,object>{{"success",true},{"version",1}};
        string id=Text(message,"directoryId"),nonce=Text(message,"nonce");
        Require(Id(id) && Token(nonce),"INVALID_MESSAGE");
        var stateFile=Path.Combine(home,"bindings.json");string root;
        using(Lock(Path.Combine(home,"bindings.lock"))) {
            var state=ReadJson(stateFile);var key=origin+id;
            root=Text(state,key);
            if(!Proof(root,nonce)) {
                root=Text(manifest,"default_root");
                if(!Proof(root,nonce) && action=="link")root=choose(Text(message,"directoryName"));
                Require(Proof(root,nonce),"DIRECTORY_LINK_REQUIRED");
                root=RootPath(root);Require(state.ContainsKey(key) || state.Count<64,"NATIVE_STORAGE_LIMIT");
                state[key]=root;Save(stateFile,state);
            }
        }
        if(action=="reveal")reveal(Path.GetDirectoryName(FilePath(root,Text(message,"filename"))));
        return new Dictionary<string,object>{{"success",true}};
    }
    internal static byte[] Read(Stream input) {
        var header=new byte[4];int n=0,count;
        while(n<4 && (count=input.Read(header,n,4-n))>0)n+=count;
        if(n==0)return null;Require(n==4,"INVALID_MESSAGE");
        var length=BitConverter.ToUInt32(header,0);Require(length>0 && length<=MaxMessage,"INVALID_MESSAGE");
        var body=new byte[(int)length];n=0;
        while(n<body.Length && (count=input.Read(body,n,body.Length-n))>0)n+=count;
        Require(n==body.Length,"INVALID_MESSAGE");return body;
    }
    [STAThread] static int Main(string[] args) {
        IDictionary<string,object> response;
        try {
            Require(args.Length>=1,"FORBIDDEN");
            var body=Read(Console.OpenStandardInput());if(body==null)return 0;
            var message=Json.Deserialize<Dictionary<string,object>>(new UTF8Encoding(false,true).GetString(body));
            response=Handle(message,args[0],Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location),name=>{
                using(var dialog=new FolderBrowserDialog { Description="Link the MediaLatch destination folder: "+(name??""), ShowNewFolderButton=false }) {
                    if(dialog.ShowDialog()!=DialogResult.OK)throw new InvalidOperationException("NATIVE_CANCELLED");
                    return dialog.SelectedPath;
                }
            },parent=>{
                var explorer=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),"explorer.exe");
                Process.Start(new ProcessStartInfo(explorer,"\""+parent+"\"") { UseShellExecute=false });
            });
        } catch(InvalidOperationException e) { response=new Dictionary<string,object>{{"success",false},{"error",Regex.IsMatch(e.Message,@"\A[A-Z_]{1,48}\z")?e.Message:"NATIVE_LOCATION_FAILED"}}; }
          catch { response=new Dictionary<string,object>{{"success",false},{"error","NATIVE_LOCATION_FAILED"}}; }
        var bytes=Encoding.UTF8.GetBytes(Json.Serialize(response));
        using(var output=Console.OpenStandardOutput()){output.Write(BitConverter.GetBytes(bytes.Length),0,4);output.Write(bytes,0,bytes.Length);output.Flush();}
        return 0;
    }
}
