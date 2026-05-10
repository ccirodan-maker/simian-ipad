// ============================================================
// cpu65816.js  ―  WDC 65816 CPU（完全実装）
//
// 全256オペコード実装。M/X フラグによる 8/16bit モード切替。
// エミュレーションモード(E=1) ↔ ネイティブモード(E=0) 対応。
// ============================================================
class CPU65816 {
  constructor(bus) {
    this.bus = bus;

    // ---- レジスタ ----
    this.A   = 0;       // アキュムレーター（最大16bit）
    this.X   = 0;       // Xインデックス（最大16bit）
    this.Y   = 0;       // Yインデックス（最大16bit）
    this.SP  = 0x01FF;  // スタックポインター
    this.DP  = 0x0000;  // ダイレクトページ
    this.PC  = 0x0000;  // プログラムカウンター（16bit）
    this.PBR = 0x00;    // プログラムバンク
    this.DBR = 0x00;    // データバンク

    // ---- ステータスフラグ ----
    this.flagN = 0;  // Negative
    this.flagV = 0;  // Overflow
    this.flagM = 1;  // Memory/Acc size: 1=8bit, 0=16bit
    this.flagX = 1;  // Index size:      1=8bit, 0=16bit
    this.flagD = 0;  // Decimal mode
    this.flagI = 1;  // IRQ disable
    this.flagZ = 0;  // Zero
    this.flagC = 0;  // Carry
    this.flagE = 1;  // Emulation mode

    // ---- 状態 ----
    this.cycles     = 0;
    this.nmiPending = false;
    this.irqPending = false;
    this.stopped    = false;
    this.waiting    = false;

    this.reset();
  }

  reset() {
    this.flagE = 1; this.flagM = 1; this.flagX = 1;
    this.flagI = 1; this.flagD = 0;
    this.PBR = 0; this.DBR = 0; this.DP = 0;
    this.SP = 0x01FF;
    this.stopped = false; this.waiting = false;
    this.nmiPending = false;
    this.PC = this.r8(0x00FFFC) | (this.r8(0x00FFFD) << 8);
  }

  // ---- P レジスタ ----
  getP() {
    return (this.flagN<<7)|(this.flagV<<6)|
           (this.flagE?0x30:((this.flagM<<5)|(this.flagX<<4)))|
           (this.flagD<<3)|(this.flagI<<2)|(this.flagZ<<1)|this.flagC;
  }
  setP(p) {
    this.flagN = (p>>7)&1; this.flagV = (p>>6)&1;
    if (!this.flagE) {
      this.flagM = (p>>5)&1; this.flagX = (p>>4)&1;
      if (this.flagX) { this.X &= 0xFF; this.Y &= 0xFF; }
    }
    this.flagD=(p>>3)&1; this.flagI=(p>>2)&1; this.flagZ=(p>>1)&1; this.flagC=p&1;
  }

  // エフェクティブサイズ（Eモードは強制8bit）
  get m8() { return this.flagE || this.flagM; }
  get x8() { return this.flagE || this.flagX; }

  // ---- メモリアクセス ----
  r8(a)    { return this.bus.read(a & 0xFFFFFF); }
  r16(a)   { return this.r8(a) | (this.r8((a+1)&0xFFFFFF)<<8); }
  r24(a)   { return this.r8(a) | (this.r8((a+1)&0xFFFFFF)<<8) | (this.r8((a+2)&0xFFFFFF)<<16); }
  w8(a,v)  { this.bus.write(a&0xFFFFFF, v&0xFF); }
  w16(a,v) { this.w8(a,v); this.w8((a+1)&0xFFFFFF, v>>8); }

  // M/X フラグに合わせた読み書き
  rM(a) { return this.m8 ? this.r8(a)  : this.r16(a); }
  rX(a) { return this.x8 ? this.r8(a)  : this.r16(a); }
  wM(a,v) { this.m8 ? this.w8(a,v) : this.w16(a,v); }
  wX(a,v) { this.x8 ? this.w8(a,v) : this.w16(a,v); }

  // ---- PC フェッチ ----
  fb()  { const v=this.r8((this.PBR<<16)|this.PC); this.PC=(this.PC+1)&0xFFFF; return v; }
  fw()  { return this.fb()|(this.fb()<<8); }
  fl()  { return this.fw()|(this.fb()<<16); }

  // イミディエイト（M/X サイズ対応）
  fmm() { const v=this.rM((this.PBR<<16)|this.PC); this.PC=(this.PC+(this.m8?1:2))&0xFFFF; return v; }
  fmx() { const v=this.rX((this.PBR<<16)|this.PC); this.PC=(this.PC+(this.x8?1:2))&0xFFFF; return v; }

  // ---- スタック ----
  push8(v)  {
    this.w8(this.SP, v&0xFF);
    this.SP = this.flagE ? (0x0100|((this.SP-1)&0xFF)) : ((this.SP-1)&0xFFFF);
  }
  push16(v) { this.push8(v>>8); this.push8(v); }
  pull8()   {
    this.SP = this.flagE ? (0x0100|((this.SP+1)&0xFF)) : ((this.SP+1)&0xFFFF);
    return this.r8(this.SP);
  }
  pull16()  { const lo=this.pull8(); return lo|(this.pull8()<<8); }

  // ---- フラグ ----
  nz8(v)  { v&=0xFF;   this.flagN=v>>7;  this.flagZ=v===0?1:0; return v; }
  nz16(v) { v&=0xFFFF; this.flagN=v>>15; this.flagZ=v===0?1:0; return v; }

  // ---- アドレッシングモード（24bit アドレスを返す） ----
  dp()   { return (this.DP+this.fb())&0xFFFF; }
  dpx()  { return (this.DP+this.fb()+this.X)&0xFFFF; }
  dpy()  { return (this.DP+this.fb()+this.Y)&0xFFFF; }
  dpi()  { const p=this.dp(); return (this.DBR<<16)|this.r16(p); }
  dpix() { const d=this.fb(); const p=(this.DP+d+this.X)&0xFFFF; return (this.DBR<<16)|this.r16(p); }
  dpiy() { const p=this.dp(); return ((this.DBR<<16)|this.r16(p))+this.Y; }
  dpl()  { return this.r24(this.dp()); }
  dply(){ return (this.r24(this.dp())+this.Y)&0xFFFFFF; }
  ab()   { return (this.DBR<<16)|this.fw(); }
  abx()  { return ((this.DBR<<16)|this.fw())+this.X; }
  aby()  { return ((this.DBR<<16)|this.fw())+this.Y; }
  abl()  { return this.fl(); }
  ablx() { return (this.fl()+this.X)&0xFFFFFF; }
  sr()   { return (this.SP+this.fb())&0xFFFF; }
  sriy() { const p=(this.SP+this.fb())&0xFFFF; return ((this.DBR<<16)|this.r16(p))+this.Y; }

  // ---- 演算ヘルパー ----
  ORA(v) {
    if(this.m8){const r=((this.A&0xFF)|v)&0xFF; this.nz8(r); this.A=(this.A&0xFF00)|r;}
    else this.A=this.nz16(this.A|v);
  }
  AND(v) {
    if(this.m8){const r=((this.A&0xFF)&v)&0xFF; this.nz8(r); this.A=(this.A&0xFF00)|r;}
    else this.A=this.nz16(this.A&v);
  }
  EOR(v) {
    if(this.m8){const r=((this.A&0xFF)^v)&0xFF; this.nz8(r); this.A=(this.A&0xFF00)|r;}
    else this.A=this.nz16(this.A^v);
  }
  ADC(v) {
    if(this.m8){
      const a=this.A&0xFF, v8=v&0xFF;
      const r=a+v8+this.flagC;
      this.flagV=((~(a^v8)&(a^r))>>7)&1;
      this.flagC=r>0xFF?1:0;
      this.A=(this.A&0xFF00)|this.nz8(r);
    } else {
      const r=this.A+v+this.flagC;
      this.flagV=((~(this.A^v)&(this.A^r)&0x8000)!==0)?1:0;
      this.flagC=r>0xFFFF?1:0;
      this.A=this.nz16(r);
    }
  }
  SBC(v) { this.ADC(this.m8?(v^0xFF)&0xFF:(v^0xFFFF)&0xFFFF); }
  CMP(v) {
    if(this.m8){const a=this.A&0xFF,r=a-(v&0xFF); this.flagC=a>=(v&0xFF)?1:0; this.nz8(r);}
    else{const r=this.A-v; this.flagC=this.A>=v?1:0; this.nz16(r);}
  }
  CPX(v) {
    if(this.x8){const x=this.X&0xFF; this.flagC=x>=(v&0xFF)?1:0; this.nz8(x-(v&0xFF));}
    else{this.flagC=this.X>=v?1:0; this.nz16(this.X-v);}
  }
  CPY(v) {
    if(this.x8){const y=this.Y&0xFF; this.flagC=y>=(v&0xFF)?1:0; this.nz8(y-(v&0xFF));}
    else{this.flagC=this.Y>=v?1:0; this.nz16(this.Y-v);}
  }
  LDA(v) { if(this.m8){this.A=(this.A&0xFF00)|this.nz8(v);}else this.A=this.nz16(v); }
  LDX(v) { this.X=this.x8?this.nz8(v):this.nz16(v); }
  LDY(v) { this.Y=this.x8?this.nz8(v):this.nz16(v); }
  STA(a) { this.wM(a,this.A); }
  STX(a) { this.wX(a,this.X); }
  STY(a) { this.wX(a,this.Y); }
  STZ(a) { this.wM(a,0); }

  ASLm(a){
    const v=this.rM(a);
    if(this.m8){this.flagC=(v>>7)&1; this.w8(a,this.nz8(v<<1));}
    else{this.flagC=(v>>15)&1; this.w16(a,this.nz16(v<<1));}
  }
  ASLA(){
    if(this.m8){const a=this.A&0xFF; this.flagC=a>>7; this.A=(this.A&0xFF00)|this.nz8(a<<1);}
    else{this.flagC=this.A>>15; this.A=this.nz16(this.A<<1);}
  }
  LSRm(a){
    const v=this.rM(a);
    if(this.m8){this.flagC=v&1; this.w8(a,this.nz8(v>>1));}
    else{this.flagC=v&1; this.w16(a,this.nz16(v>>>1));}
  }
  LSRA(){
    if(this.m8){const a=this.A&0xFF; this.flagC=a&1; this.A=(this.A&0xFF00)|this.nz8(a>>1);}
    else{this.flagC=this.A&1; this.A=this.nz16(this.A>>>1);}
  }
  ROLm(a){
    const v=this.rM(a),c=this.flagC;
    if(this.m8){this.flagC=(v>>7)&1; this.w8(a,this.nz8((v<<1)|c));}
    else{this.flagC=(v>>15)&1; this.w16(a,this.nz16((v<<1)|c));}
  }
  ROLA(){
    const c=this.flagC;
    if(this.m8){const a=this.A&0xFF; this.flagC=a>>7; this.A=(this.A&0xFF00)|this.nz8((a<<1)|c);}
    else{this.flagC=this.A>>15; this.A=this.nz16((this.A<<1)|c);}
  }
  RORm(a){
    const v=this.rM(a),c=this.flagC;
    if(this.m8){this.flagC=v&1; this.w8(a,this.nz8((c<<7)|(v>>1)));}
    else{this.flagC=v&1; this.w16(a,this.nz16((c<<15)|(v>>>1)));}
  }
  RORA(){
    const c=this.flagC;
    if(this.m8){const a=this.A&0xFF; this.flagC=a&1; this.A=(this.A&0xFF00)|this.nz8((c<<7)|(a>>1));}
    else{this.flagC=this.A&1; this.A=this.nz16((c<<15)|(this.A>>>1));}
  }
  INCm(a){const v=this.rM(a); if(this.m8)this.w8(a,this.nz8(v+1)); else this.w16(a,this.nz16(v+1));}
  DECm(a){const v=this.rM(a); if(this.m8)this.w8(a,this.nz8(v-1)); else this.w16(a,this.nz16(v-1));}
  INCA(){if(this.m8){this.A=(this.A&0xFF00)|this.nz8((this.A&0xFF)+1);}else this.A=this.nz16(this.A+1);}
  DECA(){if(this.m8){this.A=(this.A&0xFF00)|this.nz8((this.A&0xFF)-1);}else this.A=this.nz16(this.A-1);}

  BIT(v){
    if(this.m8){this.flagN=(v>>7)&1; this.flagV=(v>>6)&1; this.flagZ=((this.A&0xFF)&v)?0:1;}
    else{this.flagN=(v>>15)&1; this.flagV=(v>>14)&1; this.flagZ=(this.A&v&0xFFFF)?0:1;}
  }
  BITimm(v){ // immediate: Z only
    if(this.m8) this.flagZ=((this.A&0xFF)&v)?0:1; else this.flagZ=(this.A&v)?0:1;
  }
  TSB(a){
    const v=this.rM(a);
    if(this.m8){this.flagZ=((this.A&0xFF)&v)?0:1; this.w8(a,v|(this.A&0xFF));}
    else{this.flagZ=(this.A&v)?0:1; this.w16(a,v|this.A);}
  }
  TRB(a){
    const v=this.rM(a);
    if(this.m8){this.flagZ=((this.A&0xFF)&v)?0:1; this.w8(a,v&~(this.A&0xFF));}
    else{this.flagZ=(this.A&v)?0:1; this.w16(a,v&~this.A);}
  }
  branch(cond){
    const o=this.fb();
    if(cond) this.PC=(this.PC+((o&0x80)?o-256:o))&0xFFFF;
  }

  // ---- 割り込み ----
  doNMI(){
    this.waiting=false;
    if(this.flagE){this.push16(this.PC);this.push8(this.getP()|0x30);}
    else{this.push8(this.PBR);this.push16(this.PC);this.push8(this.getP());}
    this.flagI=1;this.flagD=0;this.PBR=0;
    this.PC=this.r16(this.flagE?0x00FFFA:0x00FFEA);
  }
  doIRQ(){
    this.waiting=false;
    if(this.flagE){this.push16(this.PC);this.push8(this.getP()&0xEF);}
    else{this.push8(this.PBR);this.push16(this.PC);this.push8(this.getP());}
    this.flagI=1;this.flagD=0;this.PBR=0;
    this.PC=this.r16(this.flagE?0x00FFFE:0x00FFEE);
  }

  // ---- 1命令実行 ----
  step(){
    if(this.stopped) return 2;
    if(this.nmiPending){this.nmiPending=false;this.doNMI();return 8;}
    if(this.irqPending&&!this.flagI){this.doIRQ();return 8;}
    if(this.waiting) return 2;
    const op=this.fb();
    const c=this.execute(op);
    this.cycles+=c;
    return c;
  }

  // ---- オペコードディスパッチ (全256) ----
  execute(op){
    switch(op){
      case 0x00:{this.fb();if(this.flagE){this.push16(this.PC);this.push8(this.getP()|0x30);}else{this.push8(this.PBR);this.push16(this.PC);this.push8(this.getP());}this.flagI=1;this.flagD=0;this.PBR=0;this.PC=this.r16(this.flagE?0x00FFFE:0x00FFE6);return 8;}
      case 0x01:this.ORA(this.rM(this.dpix()));return 6;
      case 0x02:{this.fb();if(this.flagE){this.push16(this.PC);this.push8(this.getP()|0x30);}else{this.push8(this.PBR);this.push16(this.PC);this.push8(this.getP());}this.flagI=1;this.flagD=0;this.PBR=0;this.PC=this.r16(this.flagE?0x00FFF4:0x00FFE4);return 8;}
      case 0x03:this.ORA(this.rM(this.sr()));return 4;
      case 0x04:this.TSB(this.dp());return 5;
      case 0x05:this.ORA(this.rM(this.dp()));return 3;
      case 0x06:this.ASLm(this.dp());return 5;
      case 0x07:this.ORA(this.rM(this.dpl()));return 6;
      case 0x08:this.push8(this.getP());return 3;
      case 0x09:this.ORA(this.fmm());return 2;
      case 0x0A:this.ASLA();return 2;
      case 0x0B:this.push16(this.DP);return 4;
      case 0x0C:this.TSB(this.ab());return 6;
      case 0x0D:this.ORA(this.rM(this.ab()));return 4;
      case 0x0E:this.ASLm(this.ab());return 6;
      case 0x0F:this.ORA(this.rM(this.abl()));return 5;

      case 0x10:this.branch(!this.flagN);return 2;
      case 0x11:this.ORA(this.rM(this.dpiy()));return 5;
      case 0x12:this.ORA(this.rM(this.dpi()));return 5;
      case 0x13:this.ORA(this.rM(this.sriy()));return 7;
      case 0x14:this.TRB(this.dp());return 5;
      case 0x15:this.ORA(this.rM(this.dpx()));return 4;
      case 0x16:this.ASLm(this.dpx());return 6;
      case 0x17:this.ORA(this.rM(this.dply()));return 6;
      case 0x18:this.flagC=0;return 2;
      case 0x19:this.ORA(this.rM(this.aby()));return 4;
      case 0x1A:this.INCA();return 2;
      case 0x1B:this.SP=this.flagE?(0x0100|(this.A&0xFF)):(this.A&0xFFFF);return 2; // TCS
      case 0x1C:this.TRB(this.ab());return 6;
      case 0x1D:this.ORA(this.rM(this.abx()));return 4;
      case 0x1E:this.ASLm(this.abx());return 7;
      case 0x1F:this.ORA(this.rM(this.ablx()));return 5;

      case 0x20:{const a=this.fw();this.push16((this.PC-1)&0xFFFF);this.PC=a;return 6;} // JSR
      case 0x21:this.AND(this.rM(this.dpix()));return 6;
      case 0x22:{const a=this.fl();this.push8(this.PBR);this.push16((this.PC-1)&0xFFFF);this.PBR=a>>16;this.PC=a&0xFFFF;return 8;} // JSL
      case 0x23:this.AND(this.rM(this.sr()));return 4;
      case 0x24:this.BIT(this.rM(this.dp()));return 3;
      case 0x25:this.AND(this.rM(this.dp()));return 3;
      case 0x26:this.ROLm(this.dp());return 5;
      case 0x27:this.AND(this.rM(this.dpl()));return 6;
      case 0x28:this.setP(this.pull8());return 4;
      case 0x29:this.AND(this.fmm());return 2;
      case 0x2A:this.ROLA();return 2;
      case 0x2B:this.DP=this.pull16();this.flagN=this.DP>>15;this.flagZ=this.DP?0:1;return 5; // PLD
      case 0x2C:this.BIT(this.rM(this.ab()));return 4;
      case 0x2D:this.AND(this.rM(this.ab()));return 4;
      case 0x2E:this.ROLm(this.ab());return 6;
      case 0x2F:this.AND(this.rM(this.abl()));return 5;

      case 0x30:this.branch(!!this.flagN);return 2;
      case 0x31:this.AND(this.rM(this.dpiy()));return 5;
      case 0x32:this.AND(this.rM(this.dpi()));return 5;
      case 0x33:this.AND(this.rM(this.sriy()));return 7;
      case 0x34:this.BIT(this.rM(this.dpx()));return 4;
      case 0x35:this.AND(this.rM(this.dpx()));return 4;
      case 0x36:this.ROLm(this.dpx());return 6;
      case 0x37:this.AND(this.rM(this.dply()));return 6;
      case 0x38:this.flagC=1;return 2;
      case 0x39:this.AND(this.rM(this.aby()));return 4;
      case 0x3A:this.DECA();return 2;
      case 0x3B:{this.A=this.SP&0xFFFF;this.flagN=this.A>>15;this.flagZ=this.A?0:1;return 2;} // TSC
      case 0x3C:this.BIT(this.rM(this.abx()));return 4;
      case 0x3D:this.AND(this.rM(this.abx()));return 4;
      case 0x3E:this.ROLm(this.abx());return 7;
      case 0x3F:this.AND(this.rM(this.ablx()));return 5;

      case 0x40:{this.setP(this.pull8());this.PC=this.pull16();if(!this.flagE)this.PBR=this.pull8();return 6;} // RTI
      case 0x41:this.EOR(this.rM(this.dpix()));return 6;
      case 0x42:this.fb();return 2; // WDM
      case 0x43:this.EOR(this.rM(this.sr()));return 4;
      case 0x44:{ // MVP
        const db=this.fb(),sb=this.fb();this.DBR=db;
        this.w8((db<<16)|this.Y,this.r8((sb<<16)|this.X));
        const xmask=this.x8?0xFF:0xFFFF;
        this.X=(this.X-1)&xmask;this.Y=(this.Y-1)&xmask;
        this.A=(this.A-1)&0xFFFF;if(this.A!==0xFFFF)this.PC=(this.PC-3)&0xFFFF;return 7;
      }
      case 0x45:this.EOR(this.rM(this.dp()));return 3;
      case 0x46:this.LSRm(this.dp());return 5;
      case 0x47:this.EOR(this.rM(this.dpl()));return 6;
      case 0x48:{if(this.m8)this.push8(this.A);else this.push16(this.A);return 3;} // PHA
      case 0x49:this.EOR(this.fmm());return 2;
      case 0x4A:this.LSRA();return 2;
      case 0x4B:this.push8(this.PBR);return 3; // PHK
      case 0x4C:this.PC=this.fw();return 3; // JMP abs
      case 0x4D:this.EOR(this.rM(this.ab()));return 4;
      case 0x4E:this.LSRm(this.ab());return 6;
      case 0x4F:this.EOR(this.rM(this.abl()));return 5;

      case 0x50:this.branch(!this.flagV);return 2;
      case 0x51:this.EOR(this.rM(this.dpiy()));return 5;
      case 0x52:this.EOR(this.rM(this.dpi()));return 5;
      case 0x53:this.EOR(this.rM(this.sriy()));return 7;
      case 0x54:{ // MVN
        const db=this.fb(),sb=this.fb();this.DBR=db;
        this.w8((db<<16)|this.Y,this.r8((sb<<16)|this.X));
        const xmask=this.x8?0xFF:0xFFFF;
        this.X=(this.X+1)&xmask;this.Y=(this.Y+1)&xmask;
        this.A=(this.A-1)&0xFFFF;if(this.A!==0xFFFF)this.PC=(this.PC-3)&0xFFFF;return 7;
      }
      case 0x55:this.EOR(this.rM(this.dpx()));return 4;
      case 0x56:this.LSRm(this.dpx());return 6;
      case 0x57:this.EOR(this.rM(this.dply()));return 6;
      case 0x58:this.flagI=0;return 2;
      case 0x59:this.EOR(this.rM(this.aby()));return 4;
      case 0x5A:{if(this.x8)this.push8(this.Y);else this.push16(this.Y);return 3;} // PHY
      case 0x5B:{this.DP=this.A&0xFFFF;this.flagN=this.DP>>15;this.flagZ=this.DP?0:1;return 2;} // TCD
      case 0x5C:{const a=this.fl();this.PBR=a>>16;this.PC=a&0xFFFF;return 4;} // JML
      case 0x5D:this.EOR(this.rM(this.abx()));return 4;
      case 0x5E:this.LSRm(this.abx());return 7;
      case 0x5F:this.EOR(this.rM(this.ablx()));return 5;

      case 0x60:{this.PC=(this.pull16()+1)&0xFFFF;return 6;} // RTS
      case 0x61:this.ADC(this.rM(this.dpix()));return 6;
      case 0x62:{const o=this.fw();this.push16((this.PC+o)&0xFFFF);return 6;} // PER
      case 0x63:this.ADC(this.rM(this.sr()));return 4;
      case 0x64:this.STZ(this.dp());return 3;
      case 0x65:this.ADC(this.rM(this.dp()));return 3;
      case 0x66:this.RORm(this.dp());return 5;
      case 0x67:this.ADC(this.rM(this.dpl()));return 6;
      case 0x68:{if(this.m8){this.A=(this.A&0xFF00)|this.nz8(this.pull8());}else this.A=this.nz16(this.pull16());return 4;} // PLA
      case 0x69:this.ADC(this.fmm());return 2;
      case 0x6A:this.RORA();return 2;
      case 0x6B:{this.PC=(this.pull16()+1)&0xFFFF;this.PBR=this.pull8();return 6;} // RTL
      case 0x6C:{const p=(this.PBR<<16)|this.fw();this.PC=this.r16(p);return 5;} // JMP (abs)
      case 0x6D:this.ADC(this.rM(this.ab()));return 4;
      case 0x6E:this.RORm(this.ab());return 6;
      case 0x6F:this.ADC(this.rM(this.abl()));return 5;

      case 0x70:this.branch(!!this.flagV);return 2;
      case 0x71:this.ADC(this.rM(this.dpiy()));return 5;
      case 0x72:this.ADC(this.rM(this.dpi()));return 5;
      case 0x73:this.ADC(this.rM(this.sriy()));return 7;
      case 0x74:this.STZ(this.dpx());return 4;
      case 0x75:this.ADC(this.rM(this.dpx()));return 4;
      case 0x76:this.RORm(this.dpx());return 6;
      case 0x77:this.ADC(this.rM(this.dply()));return 6;
      case 0x78:this.flagI=1;return 2;
      case 0x79:this.ADC(this.rM(this.aby()));return 4;
      case 0x7A:{if(this.x8)this.Y=this.nz8(this.pull8());else this.Y=this.nz16(this.pull16());return 4;} // PLY
      case 0x7B:{this.A=this.DP&0xFFFF;this.flagN=this.A>>15;this.flagZ=this.A?0:1;return 2;} // TDC
      case 0x7C:{const p=((this.PBR<<16)|this.fw())+this.X;this.PC=this.r16(p&0xFFFFFF);return 6;} // JMP(abs,X)
      case 0x7D:this.ADC(this.rM(this.abx()));return 4;
      case 0x7E:this.RORm(this.abx());return 7;
      case 0x7F:this.ADC(this.rM(this.ablx()));return 5;

      case 0x80:this.branch(true);return 3; // BRA
      case 0x81:this.STA(this.dpix());return 6;
      case 0x82:{const o=this.fw();this.PC=(this.PC+(o>0x7FFF?o-0x10000:o))&0xFFFF;return 4;} // BRL
      case 0x83:this.STA(this.sr());return 4;
      case 0x84:this.STY(this.dp());return 3;
      case 0x85:this.STA(this.dp());return 3;
      case 0x86:this.STX(this.dp());return 3;
      case 0x87:this.STA(this.dpl());return 6;
      case 0x88:{this.Y=this.x8?this.nz8((this.Y-1)&0xFF):this.nz16(this.Y-1);return 2;} // DEY
      case 0x89:this.BITimm(this.fmm());return 2;
      case 0x8A:this.LDA(this.X);return 2; // TXA
      case 0x8B:this.push8(this.DBR);return 3; // PHB
      case 0x8C:this.STY(this.ab());return 4;
      case 0x8D:this.STA(this.ab());return 4;
      case 0x8E:this.STX(this.ab());return 4;
      case 0x8F:this.STA(this.abl());return 5;

      case 0x90:this.branch(!this.flagC);return 2; // BCC
      case 0x91:this.STA(this.dpiy());return 6;
      case 0x92:this.STA(this.dpi());return 5;
      case 0x93:this.STA(this.sriy());return 7;
      case 0x94:this.STY(this.dpx());return 4;
      case 0x95:this.STA(this.dpx());return 4;
      case 0x96:this.STX(this.dpy());return 4;
      case 0x97:this.STA(this.dply());return 6;
      case 0x98:this.LDA(this.Y);return 2; // TYA
      case 0x99:this.STA(this.aby());return 5;
      case 0x9A:this.SP=this.X&(this.flagE?0x01FF:0xFFFF);return 2; // TXS
      case 0x9B:{const v=this.X;this.Y=this.x8?this.nz8(v&0xFF):this.nz16(v);return 2;} // TXY
      case 0x9C:this.STZ(this.ab());return 4;
      case 0x9D:this.STA(this.abx());return 5;
      case 0x9E:this.STZ(this.abx());return 5;
      case 0x9F:this.STA(this.ablx());return 5;

      case 0xA0:this.LDY(this.fmx());return 2;
      case 0xA1:this.LDA(this.rM(this.dpix()));return 6;
      case 0xA2:this.LDX(this.fmx());return 2;
      case 0xA3:this.LDA(this.rM(this.sr()));return 4;
      case 0xA4:this.LDY(this.rX(this.dp()));return 3;
      case 0xA5:this.LDA(this.rM(this.dp()));return 3;
      case 0xA6:this.LDX(this.rX(this.dp()));return 3;
      case 0xA7:this.LDA(this.rM(this.dpl()));return 6;
      case 0xA8:{const v=this.x8?(this.A&0xFF):this.A;this.Y=this.x8?this.nz8(v):this.nz16(v);return 2;} // TAY
      case 0xA9:this.LDA(this.fmm());return 2;
      case 0xAA:{const v=this.x8?(this.A&0xFF):this.A;this.X=this.x8?this.nz8(v):this.nz16(v);return 2;} // TAX
      case 0xAB:this.DBR=this.nz8(this.pull8());return 4; // PLB
      case 0xAC:this.LDY(this.rX(this.ab()));return 4;
      case 0xAD:this.LDA(this.rM(this.ab()));return 4;
      case 0xAE:this.LDX(this.rX(this.ab()));return 4;
      case 0xAF:this.LDA(this.rM(this.abl()));return 5;

      case 0xB0:this.branch(!!this.flagC);return 2; // BCS
      case 0xB1:this.LDA(this.rM(this.dpiy()));return 5;
      case 0xB2:this.LDA(this.rM(this.dpi()));return 5;
      case 0xB3:this.LDA(this.rM(this.sriy()));return 7;
      case 0xB4:this.LDY(this.rX(this.dpx()));return 4;
      case 0xB5:this.LDA(this.rM(this.dpx()));return 4;
      case 0xB6:this.LDX(this.rX(this.dpy()));return 4;
      case 0xB7:this.LDA(this.rM(this.dply()));return 6;
      case 0xB8:this.flagV=0;return 2;
      case 0xB9:this.LDA(this.rM(this.aby()));return 4;
      case 0xBA:{const v=this.SP;this.X=this.x8?this.nz8(v&0xFF):this.nz16(v);return 2;} // TSX
      case 0xBB:{this.X=this.x8?this.nz8(this.Y&0xFF):this.nz16(this.Y);return 2;} // TYX
      case 0xBC:this.LDY(this.rX(this.abx()));return 4;
      case 0xBD:this.LDA(this.rM(this.abx()));return 4;
      case 0xBE:this.LDX(this.rX(this.aby()));return 4;
      case 0xBF:this.LDA(this.rM(this.ablx()));return 5;

      case 0xC0:this.CPY(this.fmx());return 2;
      case 0xC1:this.CMP(this.rM(this.dpix()));return 6;
      case 0xC2:{const m=this.fb();this.setP(this.getP()&~m);return 3;} // REP
      case 0xC3:this.CMP(this.rM(this.sr()));return 4;
      case 0xC4:this.CPY(this.rX(this.dp()));return 3;
      case 0xC5:this.CMP(this.rM(this.dp()));return 3;
      case 0xC6:this.DECm(this.dp());return 5;
      case 0xC7:this.CMP(this.rM(this.dpl()));return 6;
      case 0xC8:{this.Y=this.x8?this.nz8((this.Y+1)&0xFF):this.nz16(this.Y+1);return 2;} // INY
      case 0xC9:this.CMP(this.fmm());return 2;
      case 0xCA:{this.X=this.x8?this.nz8((this.X-1)&0xFF):this.nz16(this.X-1);return 2;} // DEX
      case 0xCB:this.waiting=true;return 3; // WAI
      case 0xCC:this.CPY(this.rX(this.ab()));return 4;
      case 0xCD:this.CMP(this.rM(this.ab()));return 4;
      case 0xCE:this.DECm(this.ab());return 6;
      case 0xCF:this.CMP(this.rM(this.abl()));return 5;

      case 0xD0:this.branch(!this.flagZ);return 2; // BNE
      case 0xD1:this.CMP(this.rM(this.dpiy()));return 5;
      case 0xD2:this.CMP(this.rM(this.dpi()));return 5;
      case 0xD3:this.CMP(this.rM(this.sriy()));return 7;
      case 0xD4:{const a=this.dp();this.push16(this.r16(a));return 6;} // PEI
      case 0xD5:this.CMP(this.rM(this.dpx()));return 4;
      case 0xD6:this.DECm(this.dpx());return 6;
      case 0xD7:this.CMP(this.rM(this.dply()));return 6;
      case 0xD8:this.flagD=0;return 2;
      case 0xD9:this.CMP(this.rM(this.aby()));return 4;
      case 0xDA:{if(this.x8)this.push8(this.X);else this.push16(this.X);return 3;} // PHX
      case 0xDB:this.stopped=true;return 3; // STP
      case 0xDC:{const p=(this.DBR<<16)|this.fw();const a=this.r24(p);this.PBR=a>>16;this.PC=a&0xFFFF;return 6;} // JML[abs]
      case 0xDD:this.CMP(this.rM(this.abx()));return 4;
      case 0xDE:this.DECm(this.abx());return 7;
      case 0xDF:this.CMP(this.rM(this.ablx()));return 5;

      case 0xE0:this.CPX(this.fmx());return 2;
      case 0xE1:this.SBC(this.rM(this.dpix()));return 6;
      case 0xE2:{const m=this.fb();this.setP(this.getP()|m);return 3;} // SEP
      case 0xE3:this.SBC(this.rM(this.sr()));return 4;
      case 0xE4:this.CPX(this.rX(this.dp()));return 3;
      case 0xE5:this.SBC(this.rM(this.dp()));return 3;
      case 0xE6:this.INCm(this.dp());return 5;
      case 0xE7:this.SBC(this.rM(this.dpl()));return 6;
      case 0xE8:{this.X=this.x8?this.nz8((this.X+1)&0xFF):this.nz16(this.X+1);return 2;} // INX
      case 0xE9:this.SBC(this.fmm());return 2;
      case 0xEA:return 2; // NOP
      case 0xEB:{const lo=this.A&0xFF,hi=(this.A>>8)&0xFF;this.A=(lo<<8)|hi;this.nz8(hi);return 3;} // XBA
      case 0xEC:this.CPX(this.rX(this.ab()));return 4;
      case 0xED:this.SBC(this.rM(this.ab()));return 4;
      case 0xEE:this.INCm(this.ab());return 6;
      case 0xEF:this.SBC(this.rM(this.abl()));return 5;

      case 0xF0:this.branch(!!this.flagZ);return 2; // BEQ
      case 0xF1:this.SBC(this.rM(this.dpiy()));return 5;
      case 0xF2:this.SBC(this.rM(this.dpi()));return 5;
      case 0xF3:this.SBC(this.rM(this.sriy()));return 7;
      case 0xF4:{this.push16(this.fw());return 5;} // PEA
      case 0xF5:this.SBC(this.rM(this.dpx()));return 4;
      case 0xF6:this.INCm(this.dpx());return 6;
      case 0xF7:this.SBC(this.rM(this.dply()));return 6;
      case 0xF8:this.flagD=1;return 2;
      case 0xF9:this.SBC(this.rM(this.aby()));return 4;
      case 0xFA:{if(this.x8)this.X=this.nz8(this.pull8());else this.X=this.nz16(this.pull16());return 4;} // PLX
      case 0xFB:{const e=this.flagE;this.flagE=this.flagC;this.flagC=e;if(this.flagE){this.flagM=1;this.flagX=1;this.SP=0x0100|(this.SP&0xFF);this.X&=0xFF;this.Y&=0xFF;}return 2;} // XCE
      case 0xFC:{const p=((this.PBR<<16)|this.fw())+this.X;this.push16((this.PC-1)&0xFFFF);this.PC=this.r16(p&0xFFFFFF);return 8;} // JSR(abs,X)
      case 0xFD:this.SBC(this.rM(this.abx()));return 4;
      case 0xFE:this.INCm(this.abx());return 7;
      case 0xFF:this.SBC(this.rM(this.ablx()));return 5;

      default:
        console.warn(`Unknown opcode: $${op.toString(16).padStart(2,'0')} @ ${this.PBR.toString(16)}:${((this.PC-1)&0xFFFF).toString(16).padStart(4,'0')}`);
        return 2;
    }
  }
}
