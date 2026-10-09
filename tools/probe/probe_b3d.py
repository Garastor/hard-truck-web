import sys,struct,collections
d=open(sys.argv[1],'rb').read()
sz,mo,ms,do,ds=struct.unpack_from('<5I',d,4)
nm=struct.unpack_from('<I',d,mo*4)[0]
print('size ok',sz*4==len(d),'materials',nm, 'data@',do*4, 'first',struct.unpack_from('<I',d,do*4)[0])
c=collections.Counter(); names=collections.defaultdict(list)
for o in range(do*4,len(d)-40,4):
    if struct.unpack_from('<I',d,o)[0]==333:
        n=d[o+4:o+36].split(b'\0')[0]
        t=struct.unpack_from('<I',d,o+36)[0]
        if t<64 and all(32<=b<127 for b in n):
            c[t]+=1
            if n and len(names[t])<5: names[t].append(n.decode())
for t in sorted(c): print(t,c[t],names[t])
