import sys, struct, collections
d=open(sys.argv[1],'rb').read(); p=0
def cstr():
    global p
    e=d.index(b'\0',p); s=d[p:e].decode('cp1251'); p=e+1; return s
while p<len(d):
    hdr=cstr(); name,cnt=hdr.rsplit(' ',1); cnt=int(cnt)
    exts=collections.Counter(); sample=[]
    for i in range(cnt):
        if name in('COLORS','MATERIALS','SOUNDS'):
            s=cstr(); sample.append(s) if i<3 else None; continue
        fn=cstr(); sz=struct.unpack_from('<I',d,p)[0]; p+=4
        if i<2: sample.append((fn,sz,d[p:p+8]))
        p+=sz
    print(name,cnt,sample)
print('end',p,len(d))
