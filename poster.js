/* Standalone vector achievement posters, rendered from the original map geometry. */
(function (root) {
  'use strict';
  const W = 1200, H = 1600;
  const COLORS = { green: '#479975', ink: '#203c2d', muted: '#7b8c81', line: '#d9e5dc', border: '#9db7a6', paper: '#ffffff', background: '#f3f7f3' };
  const FORMATS = { png4: { width: 3072, height: 4096 }, png8: { width: 6144, height: 8192 } };
  const xml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  const attrs = object => Object.entries(object).map(([key,value]) => `${key}="${xml(value)}"`).join(' ');
  const tag = (name, properties, content = '') => `<${name} ${attrs(properties)}>${content}</${name}>`;
  const text = (value, x, y, size, extra = {}) => tag('text', {x,y,'font-size':size,fill:COLORS.ink,...extra}, xml(value));
  function decode(s) {
    const out=[];let i=0,x=0,y=0;
    while(i<s.length){const v=[];for(let axis=0;axis<2;axis++){let r=0,sh=0,b;do{b=s.charCodeAt(i++)-63;r|=(b&31)<<sh;sh+=5;}while(b>=32);v.push((r&1)?~(r>>1):r>>1);}x+=v[0];y+=v[1];out.push(x/10,y/10);}
    return out;
  }
  function linePath(points, close=false) {let s='';for(let i=0;i<points.length;i+=2)s+=(i?'L':'M')+points[i]+','+points[i+1];return s+(close?'Z':'');}
  function pathFor(unit) {return unit.path || unit.p.map(p=>linePath(decode(p),true)).join('');}
  function statistics(data, provinces, codes, provinceName) {
    const known=new Set(data.units.map(u=>u.code));
    const visited=new Set([...codes].filter(code=>known.has(code)));
    const p=provinceName?provinces.find(p=>p.name===provinceName):null;
    if(provinceName&&!p)throw new Error('找不到所选省级行政区');
    return { visited, provinces:provinces.filter(p=>p.ids.some(i=>visited.has(data.units[i].code))).length,
      cities:visited.size, provinceTotal:provinces.length, cityTotal:data.units.length,
      localCities:p?p.ids.filter(i=>visited.has(data.units[i].code)).length:visited.size,
      localTotal:p?p.ids.length:data.units.length, province:p };
  }
  function build(options) {
    const {data,provinces,visited:codes,provinceName=null,layer='province',showLabels=true,pixelWidth=W,pixelHeight=H}=options;
    const stats=statistics(data,provinces,codes,provinceName), p=stats.province;
    const isCity=Boolean(p)||layer==='city';
    const title=p?p.short+'足迹':'我的足迹';
    const scope=p?`${p.name} · 已到访 ${stats.localCities} / ${stats.localTotal} 个城市 / 地区`:`中国 · ${isCity?'市级':'省级'}足迹`;
    // Reserve the right-hand sea area for the inset, including on the Hainan poster.
    const box=p?.name==='海南省'?{x:90,y:292,w:800,h:880}:{x:82,y:292,w:1036,h:880};
    const bounds=p?p.b:[0,0,data.w,data.h];
    const fit=Math.min(box.w/(bounds[2]-bounds[0]),box.h/(bounds[3]-bounds[1]),p?Infinity:.95);
    const tx=box.x+(box.w-(bounds[2]-bounds[0])*fit)/2-bounds[0]*fit;
    const ty=box.y+(box.h-(bounds[3]-bounds[1])*fit)/2-bounds[1]*fit;
    const main=[];
    const candidates=p?p.ids.map(i=>data.units[i]):data.units;
    function shape(d,fill,width=.8,stroke=COLORS.border) {return tag('path',{d,fill,stroke,'stroke-width':width/fit,'stroke-linejoin':'round','fill-rule':'evenodd'});}
    if(isCity){
      candidates.filter(u=>u.f===0).forEach(u=>{
        const fill=stats.visited.has(u.code)?COLORS.green:COLORS.paper;
        main.push(shape(pathFor(u),fill,.7));
        if(Math.min(u.b[2]-u.b[0],u.b[3]-u.b[1])*fit<2.5)main.push(tag('circle',{cx:u.cx,cy:u.cy,r:2.2/fit,fill,stroke:COLORS.border,'stroke-width':.6/fit}));
      });
      if(!p)provinces.forEach(q=>main.push(shape(q.path,'none',1.2,'#718f7a')));
    }else{
      provinces.forEach(q=>main.push(shape(q.path,q.ids.some(i=>stats.visited.has(data.units[i].code))?COLORS.green:COLORS.paper,1)));
    }
    if(!p)data.jd.forEach(s=>main.push(shape(linePath(decode(s)),'none',1.2,'#719b89')));
    const mapContent=tag('g',{transform:`translate(${tx},${ty}) scale(${fit})`},main.join(''));
    const reserved=[];
    let inset='';
    if(!p||p.name==='海南省'){
      const iw=124,ih=iw*data.inH/data.inW,ix=990,iy=1010;
      reserved.push([ix-8,iy-8,ix+iw+8,iy+ih+8]);
      const k=iw/data.inW,parts=[];
      data.units.filter(u=>u.f===1).forEach(u=>{
        const fill=stats.visited.has(u.code)?COLORS.green:COLORS.paper;
        parts.push(tag('path',{d:pathFor(u),fill,stroke:COLORS.border,'stroke-width':.9/k}));
        (u.d||[]).forEach(pt=>parts.push(tag('circle',{cx:pt[0],cy:pt[1],r:2.1/k,fill,stroke:COLORS.border,'stroke-width':.6/k})));
      });
      data.jdInset.forEach(s=>parts.push(tag('path',{d:linePath(decode(s)),fill:'none',stroke:'#719b89','stroke-width':1/k,'stroke-linecap':'round'})));
      inset=tag('rect',{x:ix,y:iy,width:iw,height:ih,rx:10,fill:'#fff',stroke:'#cfddd2','stroke-width':1})
        +tag('g',{transform:`translate(${ix},${iy}) scale(${k})`},parts.join(''))
        +text('南海诸岛',ix+iw/2,iy+ih-9,13,{'text-anchor':'middle',fill:COLORS.muted});
    }
    const names=[];
    if(showLabels){
      const items=isCity?candidates.filter(u=>u.f===0&&(p||stats.visited.has(u.code))):provinces;
      const ordered=[...items].sort((a,b)=>Number(stats.visited.has(b.code))-Number(stats.visited.has(a.code)));
      const occupied=[...reserved];
      // Nationwide city labels sit outside visited blocks, so a small city's fill stays visible.
      if(isCity&&!p)ordered.forEach(u=>occupied.push([tx+u.b[0]*fit-2,ty+u.b[1]*fit-2,tx+u.b[2]*fit+2,ty+u.b[3]*fit+2]));
      const font=isCity?18:21;
      for(const item of ordered){
        const sx=tx+item.cx*fit,sy=ty+item.cy*fit,label=item.short;
        const tw=label.length*font,th=font+6;
        const shifts=[[0,0],[0,-24],[0,24],[-tw/2-12,0],[tw/2+12,0],[-tw/2-10,-24],[tw/2+10,24],[0,-48],[0,48]];
        let chosen=null;
        for(const [dx,dy] of shifts){
          const x=sx+dx,y=sy+dy,b=[x-tw/2-4,y-th/2-3,x+tw/2+4,y+th/2+3];
          if(b[0]<box.x||b[2]>box.x+box.w||b[1]<box.y-3||b[3]>box.y+box.h+4)continue;
          if(occupied.some(r=>b[0]<r[2]&&b[2]>r[0]&&b[1]<r[3]&&b[3]>r[1]))continue;
          chosen={x,y,dx,dy,b};break;
        }
        if(!chosen)continue;
        occupied.push(chosen.b);
        if(chosen.dx||chosen.dy)names.push(tag('line',{x1:sx,y1:sy,x2:chosen.x,y2:chosen.y,stroke:'#92ad9a','stroke-width':.9}));
        names.push(text(label,chosen.x,chosen.y,font,{'text-anchor':'middle','dominant-baseline':'middle','paint-order':'stroke',stroke:'#fff','stroke-width':2.5,'stroke-linejoin':'round','font-weight':isCity?500:600}));
      }
    }
    const legendY=1206;
    const legend=tag('rect',{x:454,y:legendY-12,width:16,height:16,rx:4,fill:COLORS.green})+text('去过',481,legendY+2,17,{fill:COLORS.muted})
      +tag('rect',{x:604,y:legendY-12,width:16,height:16,rx:4,fill:'#fff',stroke:COLORS.border,'stroke-width':1})+text('未去过',631,legendY+2,17,{fill:COLORS.muted});
    function metric(value,total,label,x){
      const left=x-210,w=420,progress=w*value/total;
      return tag('text',{x,y:1392,'text-anchor':'middle',fill:COLORS.ink,'font-size':90,'font-weight':700,'font-variant-numeric':'tabular-nums'},
        tag('tspan',{},xml(value))+tag('tspan',{'font-size':24,'font-weight':400,fill:'#91a195'},' / '+xml(total)))
        +text(label,x,1432,23,{'text-anchor':'middle',fill:'#506d59'})
        +tag('rect',{x:left,y:1464,width:w,height:5,rx:2.5,fill:'#e7eee8'})
        +(progress?tag('rect',{x:left,y:1464,width:progress,height:5,rx:2.5,fill:COLORS.green}):'');
    }
    const description=`${scope}；全国累计到访 ${stats.provinces} 个省级行政区、${stats.cities} 个城市或地区。`;
    const content=tag('title',{},xml(title))+tag('desc',{},xml(description))
      +tag('rect',{width:W,height:H,fill:COLORS.background})
      +tag('rect',{x:28,y:28,width:1144,height:1544,rx:34,fill:'#fff',stroke:'#e0e9e1','stroke-width':1.2})
      +tag('rect',{x:86,y:83,width:37,height:37,rx:12,fill:COLORS.green})
      +tag('path',{d:'M96 99l8 6v-6l9 6',fill:'none',stroke:'#fff','stroke-width':3.4,'stroke-linecap':'round','stroke-linejoin':'round'})
      +text('足迹地图',137,110,23,{'font-weight':600,fill:'#4c705b'})
      +text(title,86,204,67,{'font-weight':700,'letter-spacing':2})
      +text(scope,89,252,22,{fill:COLORS.muted})
      +mapContent+names.join('')+inset+legend
      +tag('line',{x1:88,y1:1250,x2:1112,y2:1250,stroke:COLORS.line,'stroke-width':1})
      +text(p?'我的全国足迹':'累计到访',600,1290,17,{'text-anchor':'middle',fill:COLORS.muted,'letter-spacing':3})
      +metric(stats.provinces,stats.provinceTotal,'个省级行政区',335)
      +tag('line',{x1:600,y1:1320,x2:600,y2:1438,stroke:COLORS.line,'stroke-width':1})
      +metric(stats.cities,stats.cityTotal,'个城市 / 地区',865)
      +text('城市按本地图的记录单元统计，包含自治州等地区。',600,1510,13,{'text-anchor':'middle',fill:'#8c9d90'})
      +text('地图为原项目示意数据，仅用于个人足迹记录。',600,1538,12,{'text-anchor':'middle',fill:'#a3afa6'});
    const svg=tag('svg',{xmlns:'http://www.w3.org/2000/svg',width:pixelWidth,height:pixelHeight,viewBox:`0 0 ${W} ${H}`,'font-family':'PingFang SC,Microsoft YaHei,Arial,sans-serif','shape-rendering':'geometricPrecision'},content);
    return {svg,stats,title,scope,description};
  }
  root.FootprintPoster={build,statistics,FORMATS};
})(typeof window==='undefined'?globalThis:window);
