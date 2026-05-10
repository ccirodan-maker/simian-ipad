// ============================================================
// ppu.js  v5  ―  SFC PPU
//   Phase 5 変更点:
//     1. ウィンドウマスク完全実装 (BG/OBJ/カラー演算)
//     2. TMW/TSW: メイン/サブスクリーン別ウィンドウ
//     3. カラー演算 cgwsel の "Force Main Black" 対応
//     4. 優先度合成: サブスクリーンを正確に追跡
// ============================================================
class PPU {
  constructor() {
    this.vram  = new Uint16Array(0x8000);
    this.cgram = new Uint16Array(256);
    this.oam   = new Uint8Array(544);

    this.framebuf  = new Uint8ClampedArray(256 * 224 * 4);
    this.canvas    = null;
    this.ctx       = null;
    this.imageData = null;

    this.inidisp = 0x8F;
    this.obsel   = 0;
    this.bgmode  = 0;
    this.mosaic  = 0;
    this.bgsc    = [0,0,0,0];
    this.bgnba   = [0,0,0,0];
    this.bghofs  = [0,0,0,0];
    this.bgvofs  = [0,0,0,0];
    this._scrollLatch = 0;
    this.tm  = 0x1F;
    this.ts  = 0x00;
    this.tmw = 0x00;   // メインスクリーン ウィンドウマスク有効BG
    this.tsw = 0x00;   // サブスクリーン  ウィンドウマスク有効BG

    // ウィンドウ設定
    this.w1left=0; this.w1right=0xFF;
    this.w2left=0; this.w2right=0xFF;
    // BGxSEL bits: [W1en, W1inv, W2en, W2inv] per BG (packed into 4bit each)
    this.w12sel=[0,0,0,0];
    this.wobjsel=0; this.wcolsel=0;
    this.wbglog=0;   // $212A BG1-4 window logic (2bit each)
    this.wobjlog=0;  // $212B OBJ/color window logic

    // カラー演算
    this.cgwsel=0; this.cgadsub=0;
    this._fixedR=0; this._fixedG=0; this._fixedB=0;

    this.vmain=0x80; this.vmadd=0; this._vmReadBuf=0;
    this.cgadd=0; this._cgLatch=0; this._cgFlag=false;
    this.oamadd=0; this._oamReload=0; this._oamLatch=0;

    this.m7sel=0; this.m7a=0; this.m7b=0; this.m7c=0; this.m7d=0;
    this.m7x=0; this.m7y=0; this._m7latch=0;

    this.scanline=0; this.frameCount=0;

    this._bgLine = [ new Uint16Array(256), new Uint16Array(256),
                     new Uint16Array(256), new Uint16Array(256) ];
    this._objLine    = new Int32Array(256);
    this._objPri     = new Uint8Array(256);
  }

  setCanvas(c) {
    this.canvas=c; this.ctx=c.getContext('2d');
    c.width=256; c.height=224;
    this.imageData=this.ctx.createImageData(256,224);
  }

  // ================================================================
  //  READ
  // ================================================================
  read(addr) {
    switch(addr) {
      case 0x2134: return ((this.m7a*(this.m7b>>8))&0xFFFFFF)&0xFF;
      case 0x2135: return ((this.m7a*(this.m7b>>8))&0xFFFFFF)>>8&0xFF;
      case 0x2136: return ((this.m7a*(this.m7b>>8))&0xFFFFFF)>>16&0xFF;
      case 0x2137: return 0;
      case 0x2138: {const v=this.oam[this.oamadd&0x21F];this.oamadd=(this.oamadd+1)&0x3FF;return v;}
      case 0x2139: {const v=this._vmReadBuf&0xFF;if(!(this.vmain&0x80))this._vmInc();return v;}
      case 0x213A: {const v=(this._vmReadBuf>>8)&0xFF;if(this.vmain&0x80)this._vmInc();return v;}
      case 0x213B: {
        let v;
        if(!this._cgFlag) v=this.cgram[this.cgadd]&0xFF;
        else{v=(this.cgram[this.cgadd]>>8)&0x7F;this.cgadd=(this.cgadd+1)&0xFF;}
        this._cgFlag=!this._cgFlag; return v;
      }
      case 0x213C: return 0;
      case 0x213D: return this.scanline&0xFF;
      case 0x213E: return 0x01;
      case 0x213F: return 0x03;
      default: return 0;
    }
  }

  // ================================================================
  //  WRITE
  // ================================================================
  write(addr, val) {
    switch(addr) {
      case 0x2100: this.inidisp=val; break;
      case 0x2101: this.obsel=val; break;
      case 0x2102: this._oamReload=(this._oamReload&0x100)|val; this.oamadd=(this._oamReload<<1)&0x3FF; break;
      case 0x2103: this._oamReload=((val&1)<<8)|(this._oamReload&0xFF); this.oamadd=(this._oamReload<<1)&0x3FF; break;
      case 0x2104: {
        // High OAM ($200-$21F): バイト単位で即時コミット (ペアラッチなし)
        // Low OAM:  偶数アドレスでラッチ、奇数アドレスでペアコミット
        if (this.oamadd >= 0x200) {
          this.oam[0x200 | (this.oamadd & 0x1F)] = val;
        } else if ((this.oamadd & 1) === 0) {
          this._oamLatch = val;
        } else {
          this.oam[this.oamadd - 1] = this._oamLatch;
          this.oam[this.oamadd] = val;
        }
        this.oamadd = (this.oamadd + 1) & 0x3FF;
        break;
      }
      case 0x2105: this.bgmode=val; break;
      case 0x2106: this.mosaic=val; break;
      case 0x2107: this.bgsc[0]=val; break;
      case 0x2108: this.bgsc[1]=val; break;
      case 0x2109: this.bgsc[2]=val; break;
      case 0x210A: this.bgsc[3]=val; break;
      case 0x210B: this.bgnba[0]=val&0xF;this.bgnba[1]=(val>>4)&0xF; break;
      case 0x210C: this.bgnba[2]=val&0xF;this.bgnba[3]=(val>>4)&0xF; break;
      case 0x210D: this.bghofs[0]=((val<<8)|this._scrollLatch)&0x3FF;this._scrollLatch=val; break;
      case 0x210E: this.bgvofs[0]=((val<<8)|this._scrollLatch)&0x1FF;this._scrollLatch=val; break;
      case 0x210F: this.bghofs[1]=((val<<8)|this._scrollLatch)&0x3FF;this._scrollLatch=val; break;
      case 0x2110: this.bgvofs[1]=((val<<8)|this._scrollLatch)&0x1FF;this._scrollLatch=val; break;
      case 0x2111: this.bghofs[2]=((val<<8)|this._scrollLatch)&0x3FF;this._scrollLatch=val; break;
      case 0x2112: this.bgvofs[2]=((val<<8)|this._scrollLatch)&0x1FF;this._scrollLatch=val; break;
      case 0x2113: this.bghofs[3]=((val<<8)|this._scrollLatch)&0x3FF;this._scrollLatch=val; break;
      case 0x2114: this.bgvofs[3]=((val<<8)|this._scrollLatch)&0x1FF;this._scrollLatch=val; break;
      case 0x2115: this.vmain=val; break;
      case 0x2116: this.vmadd=(this.vmadd&0x7F00)|val;this._vmPrefetch(); break;
      case 0x2117: this.vmadd=((val&0x7F)<<8)|(this.vmadd&0xFF);this._vmPrefetch(); break;
      case 0x2118: this.vram[this.vmadd&0x7FFF]=(this.vram[this.vmadd&0x7FFF]&0xFF00)|val;
                   if(!(this.vmain&0x80))this._vmInc(); break;
      case 0x2119: this.vram[this.vmadd&0x7FFF]=(this.vram[this.vmadd&0x7FFF]&0x00FF)|(val<<8);
                   if(this.vmain&0x80)this._vmInc(); break;
      case 0x211A: this.m7sel=val; break;
      case 0x211B: this.m7a=(val<<8)|this._m7latch; this._m7latch=val; break;
      case 0x211C: this.m7b=(val<<8)|this._m7latch; this._m7latch=val; break;
      case 0x211D: this.m7c=(val<<8)|this._m7latch; this._m7latch=val; break;
      case 0x211E: this.m7d=(val<<8)|this._m7latch; this._m7latch=val; break;
      case 0x211F: this.m7x=(val<<8)|this._m7latch; this._m7latch=val; break;
      case 0x2120: this.m7y=(val<<8)|this._m7latch; this._m7latch=val; break;
      case 0x2121: this.cgadd=val;this._cgFlag=false; break;
      case 0x2122: {
        if(!this._cgFlag) this._cgLatch=val;
        else{this.cgram[this.cgadd]=this._cgLatch|((val&0x7F)<<8);this.cgadd=(this.cgadd+1)&0xFF;}
        this._cgFlag=!this._cgFlag; break;
      }
      // ウィンドウ設定 ($2123-$2129)
      case 0x2123: this.w12sel[0]=val&0xF;this.w12sel[1]=(val>>4)&0xF; break;
      case 0x2124: this.w12sel[2]=val&0xF;this.w12sel[3]=(val>>4)&0xF; break;
      case 0x2125: this.wobjsel=val&0xF;this.wcolsel=(val>>4)&0xF; break;
      case 0x2126: this.w1left=val; break;
      case 0x2127: this.w1right=val; break;
      case 0x2128: this.w2left=val; break;
      case 0x2129: this.w2right=val; break;
      case 0x212A: this.wbglog=val; break;    // BG1-4 window logic
      case 0x212B: this.wobjlog=val; break;   // OBJ/color window logic
      case 0x212C: this.tm=val; break;
      case 0x212D: this.ts=val; break;
      case 0x212E: this.tmw=val; break;        // ★ TMW: メインスクリーン ウィンドウマスク
      case 0x212F: this.tsw=val; break;        // ★ TSW: サブスクリーン
      case 0x2130: this.cgwsel=val; break;
      case 0x2131: this.cgadsub=val; break;
      case 0x2132: {
        const n=val&0x1F;
        if(val&0x20) this._fixedR=n;
        if(val&0x40) this._fixedG=n;
        if(val&0x80) this._fixedB=n;
        break;
      }
      case 0x2133: break;
    }
  }

  _vmPrefetch(){this._vmReadBuf=this.vram[this.vmadd&0x7FFF];}
  _vmInc(){
    const inc=[1,32,128,128][this.vmain&3];
    this.vmadd=(this.vmadd+inc)&0x7FFF;
    this._vmPrefetch();
  }

  // ================================================================
  //  ウィンドウマスク計算
  //  sel: w12sel[bgIdx] の 4bit 値 (bit0=W1en, bit1=W1inv, bit2=W2en, bit3=W2inv)
  //  logic: wbglog の 2bit 値 (00=OR, 01=AND, 10=XOR, 11=XNOR)
  //  戻り値: true = このピクセルをマスク (非表示)
  // ================================================================
  _winMask(x, sel, logic) {
    const w1en  = (sel >> 0) & 1;
    const w1inv = (sel >> 1) & 1;
    const w2en  = (sel >> 2) & 1;
    const w2inv = (sel >> 3) & 1;

    if (!w1en && !w2en) return false;

    let w1 = false, w2 = false;
    if (w1en) w1 = (x >= this.w1left && x <= this.w1right) ^ !!w1inv;
    if (w2en) w2 = (x >= this.w2left && x <= this.w2right) ^ !!w2inv;

    if (!w1en) return w2;
    if (!w2en) return w1;

    switch (logic & 3) {
      case 0: return w1 || w2;    // OR
      case 1: return w1 && w2;   // AND
      case 2: return !!(w1 ^ w2); // XOR
      case 3: return !(w1 ^ w2);  // XNOR
    }
    return false;
  }

  // ================================================================
  //  Mode 0 パレットオフセット
  // ================================================================
  _palBase2bpp(bgIdx) {
    if ((this.bgmode & 7) === 0) return bgIdx * 0x20;
    return 0;
  }

  // ================================================================
  //  BG スキャンラインバッファ構築
  // ================================================================
  _buildBGLine(bgIdx, y, bpp) {
    const buf     = this._bgLine[bgIdx];
    const hofs    = this.bghofs[bgIdx];
    const vofs    = this.bgvofs[bgIdx];
    const sc      = this.bgsc[bgIdx];
    const mapBase = (sc >> 2) << 10;
    const chrBase = this.bgnba[bgIdx] << 12;
    const scW     = (sc & 1) ? 2 : 1;
    const scH     = (sc & 2) ? 2 : 1;
    const palBase2= this._palBase2bpp(bgIdx);
    // 16x16タイルサポート (bgmode bits 4-7)
    const large   = !!(this.bgmode & (1 << (4 + bgIdx)));
    const tileSize = large ? 16 : 8;
    const tileMask = tileSize - 1;
    const tileShift = large ? 4 : 3;

    const scrolledY = (y + vofs) & ((scH * 256) - 1);
    const tileY     = (scrolledY >> tileShift) & 31;
    const fineY     = scrolledY & tileMask;
    const scY       = scrolledY >= 256 ? 1 : 0;

    for (let x = 0; x < 256; x++) {
      const scrolledX = (x + hofs) & ((scW * 256) - 1);
      const tileX     = (scrolledX >> tileShift) & 31;
      const fineX     = scrolledX & tileMask;
      const scX       = scrolledX >= 256 ? 1 : 0;

      let scN = 0;
      if (sc & 1) scN  = scX;
      if (sc & 2) scN |= scY << ((sc & 1) ? 1 : 0);

      const mapAddr = (mapBase + scN * 0x400 + tileY * 32 + tileX) & 0x7FFF;
      const entry   = this.vram[mapAddr];
      const tileNo  = entry & 0x3FF;
      const palNo   = (entry >> 10) & 7;
      const priFlag = (entry >> 13) & 1;
      const flipH   = (entry >> 14) & 1;
      const flipV   = (entry >> 15) & 1;

      // 16x16タイルの場合、8x8サブタイル内の位置に変換
      let bfx, bfy;
      if (large) {
        const subTileX = flipH ? (1 - (fineX >> 3)) : (fineX >> 3);
        const subTileY = flipV ? (1 - (fineY >> 3)) : (fineY >> 3);
        bfx = flipH ? (7 - (fineX & 7)) : (fineX & 7);
        bfy = flipV ? (7 - (fineY & 7)) : (fineY & 7);
        // tileNoを16x16グリッド内のサブタイルに調整
        var adjTileNo = ((tileNo & 0x3F0) | ((tileNo + subTileX) & 0x0F)) + subTileY * 16;
      } else {
        bfx = flipH ? (7 - fineX) : fineX;
        bfy = flipV ? (7 - fineY) : fineY;
        var adjTileNo = tileNo;
      }

      let ci = 0;
      if (bpp === 4) {
        const tbase = (chrBase + adjTileNo * 16) & 0x7FFF;
        const lo = this.vram[(tbase + bfy) & 0x7FFF];
        const hi = this.vram[(tbase + 8 + bfy) & 0x7FFF];
        const b  = 7 - bfx;
        ci = ((lo>>b)&1)|(((lo>>(b+8))&1)<<1)|(((hi>>b)&1)<<2)|(((hi>>(b+8))&1)<<3);
        if (ci) ci |= palNo << 4;
      } else if (bpp === 2) {
        const wa = (chrBase + adjTileNo * 8 + bfy) & 0x7FFF;
        const lo = this.vram[wa];
        const b  = 7 - bfx;
        ci = ((lo>>b)&1)|(((lo>>(b+8))&1)<<1);
        if (ci) ci = palBase2 | (palNo << 2) | ci;
      } else if (bpp === 8) {
        const tbase = (chrBase + adjTileNo * 32) & 0x7FFF;
        const w0=this.vram[(tbase+bfy)&0x7FFF];
        const w1=this.vram[(tbase+8+bfy)&0x7FFF];
        const w2=this.vram[(tbase+16+bfy)&0x7FFF];
        const w3=this.vram[(tbase+24+bfy)&0x7FFF];
        const b=7-bfx;
        ci=((w0>>b)&1)|(((w0>>(b+8))&1)<<1)|(((w1>>b)&1)<<2)|(((w1>>(b+8))&1)<<3)|
           (((w2>>b)&1)<<4)|(((w2>>(b+8))&1)<<5)|(((w3>>b)&1)<<6)|(((w3>>(b+8))&1)<<7);
      }

      buf[x] = ci ? ((ci << 1) | priFlag) : 0;
    }
  }

  // ================================================================
  //  Mode 7
  // ================================================================
  _buildMode7Line(y) {
    const buf = this._bgLine[0];
    const a = ((this.m7a << 16) >> 16);
    const b = ((this.m7b << 16) >> 16);
    const c = ((this.m7c << 16) >> 16);
    const d = ((this.m7d << 16) >> 16);
    const cx = (this.m7x & 0x1FFF); const cx13 = cx >= 0x1000 ? cx - 0x2000 : cx;
    const cy = (this.m7y & 0x1FFF); const cy13 = cy >= 0x1000 ? cy - 0x2000 : cy;
    const hofs = (this.bghofs[0] & 0x1FFF); const hofs13 = hofs >= 0x1000 ? hofs - 0x2000 : hofs;
    const vofs = (this.bgvofs[0] & 0x1FFF); const vofs13 = vofs >= 0x1000 ? vofs - 0x2000 : vofs;
    const wrap = !(this.m7sel & 1);
    const fill = !!(this.m7sel & 2);
    const py = y + vofs13 - cy13;

    for (let x = 0; x < 256; x++) {
      const px = x + hofs13 - cx13;
      let mx = Math.round((a * px + b * py) / 256) + cx13;
      let my = Math.round((c * px + d * py) / 256) + cy13;

      if (mx < 0 || mx > 1023 || my < 0 || my > 1023) {
        if (!wrap) { buf[x] = fill ? 0 : 0; continue; }
        mx = ((mx % 1024) + 1024) % 1024;
        my = ((my % 1024) + 1024) % 1024;
      }
      const tileNo = this.vram[((my >> 3) * 128 + (mx >> 3)) & 0x7FFF] & 0xFF;
      const ci = this.vram[(tileNo * 64 + (my & 7) * 8 + (mx & 7)) & 0x7FFF] & 0xFF;
      buf[x] = ci ? (ci << 1) : 0;
    }
  }

  // ================================================================
  //  OBJ スキャンラインバッファ
  // ================================================================
  _buildObjLine(y) {
    const line = this._objLine;
    const pri  = this._objPri;
    line.fill(-1);

    // OBSEL bit5-7: small/large [sw,sh,lw,lh]
    // 6=16x32/32x64, 7=16x32/32x32 (どちらも非ドキュメント)
    const SIZES = [
      [8,8,16,16],[8,8,32,32],[8,8,64,64],
      [16,16,32,32],[16,16,64,64],[32,32,64,64],
      [16,32,32,64],[16,32,32,32]
    ];
    const st = (this.obsel >> 5) & 7;
    const [ssw, ssh, slw, slh] = SIZES[st];

    const chrBase1 = (this.obsel & 7) << 13;
    const gap      = (((this.obsel >> 3) & 3) + 1) << 12;
    const chrBase2 = (chrBase1 + gap) & 0x7FFF;

    for (let i = 127; i >= 0; i--) {
      const b   = i * 4;
      let sx    = this.oam[b];
      const sy  = this.oam[b+1];
      const tno = this.oam[b+2];
      const at  = this.oam[b+3];
      const ext = this.oam[0x200 + (i >> 2)];
      const bits= (ext >> ((i & 3) * 2)) & 3;
      if (bits & 1) sx |= 0x100;
      const large = (bits >> 1) & 1;
      const sw = large ? slw : ssw;
      const sh = large ? slh : ssh;

      const oy = (y - sy) & 0xFF;
      if (oy >= sh) continue;

      // OAM byte 3 layout: vh oo ppp c
      //   bit7=Vflip, bit6=Hflip, bit5-4=priority,
      //   bit3-1=palette (0..7), bit0=tile bit9 (OBJテーブル上下選択)
      const flipV = (at >> 7) & 1;
      const flipH = (at >> 6) & 1;
      const sprPri  = (at >> 4) & 3;
      const palBase = 128 + (((at >> 1) & 7) << 4);
      const nameTab = at & 1;
      const chrBase  = nameTab ? chrBase2 : chrBase1;
      const fy = flipV ? (sh - 1 - oy) : oy;

      for (let col = 0; col < sw; col++) {
        const rawX = ((sx > 255 ? sx - 512 : sx) + col) & 0x1FF;
        if (rawX >= 256) continue;
        const fx = flipH ? (sw - 1 - col) : col;
        const bfx = fx & 7, bfy = fy & 7;
        const tileN = ((tno & 0xF0) | ((tno + (fx >> 3)) & 0x0F)) + (fy >> 3) * 16;
        const tbase = (chrBase + (tileN & 0x1FF) * 16) & 0x7FFF;
        const lo = this.vram[(tbase + bfy) & 0x7FFF];
        const hi = this.vram[(tbase + 8 + bfy) & 0x7FFF];
        const bt = 7 - bfx;
        const ci = ((lo>>bt)&1)|(((lo>>(bt+8))&1)<<1)|(((hi>>bt)&1)<<2)|(((hi>>(bt+8))&1)<<3);
        if (ci === 0) continue;
        line[rawX] = palBase | ci;
        pri[rawX]  = sprPri;
      }
    }
  }

  // ================================================================
  //  カラー演算
  // ================================================================
  _colorMath(mainCI, subCI, subIsTransparent) {
    const subtract = (this.cgadsub >> 7) & 1;
    const half     = (this.cgadsub >> 6) & 1;
    const useFixed = (this.cgwsel >> 1) & 1;

    let sr, sg, sb;
    if (useFixed || subIsTransparent) {
      const fr=this._fixedR, fg=this._fixedG, fb=this._fixedB;
      sr=(fr<<3)|(fr>>2); sg=(fg<<3)|(fg>>2); sb=(fb<<3)|(fb>>2);
    } else {
      const c = this.cgram[subCI & 0xFF];
      const _sr=((c)&0x1F),_sg=((c>>5)&0x1F),_sb=((c>>10)&0x1F);
      sr=(_sr<<3)|(_sr>>2); sg=(_sg<<3)|(_sg>>2); sb=(_sb<<3)|(_sb>>2);
    }
    const mc = this.cgram[mainCI & 0xFF];
    const _mr=((mc)&0x1F),_mg=((mc>>5)&0x1F),_mb=((mc>>10)&0x1F);
    let mr=(_mr<<3)|(_mr>>2);
    let mg=(_mg<<3)|(_mg>>2);
    let mb=(_mb<<3)|(_mb>>2);
    if (subtract) {
      mr = Math.max(0, mr - sr); mg = Math.max(0, mg - sg); mb = Math.max(0, mb - sb);
    } else {
      mr = Math.min(255, mr + sr); mg = Math.min(255, mg + sg); mb = Math.min(255, mb + sb);
    }
    if (half) { mr >>= 1; mg >>= 1; mb >>= 1; }
    return [mr, mg, mb];
  }

  // ================================================================
  //  1スキャンライン レンダリング (ウィンドウマスク付き)
  // ================================================================
  renderScanline(y) {
    if (y >= 224) return;
    this.scanline = y;

    const forcedBlank = (this.inidisp & 0x80) !== 0;
    const brightness  = forcedBlank ? 0 : ((this.inidisp & 0x0F) / 15);
    const lineBase    = y * 256 * 4;

    if (forcedBlank) {
      for (let x=0;x<256;x++){const o=lineBase+x*4;this.framebuf[o]=this.framebuf[o+1]=this.framebuf[o+2]=0;this.framebuf[o+3]=255;}
      return;
    }

    const mode = this.bgmode & 7;
    const bppTbl = [
      [2,2,2,2],[4,4,2,0],[4,4,0,0],[8,4,0,0],
      [8,2,0,0],[4,2,0,0],[4,0,0,0],[0,0,0,0]
    ];
    const bpps = bppTbl[mode];

    if (mode === 7) {
      this._buildMode7Line(y);
      this._bgLine[1].fill(0); this._bgLine[2].fill(0); this._bgLine[3].fill(0);
    } else {
      for (let bg=0;bg<4;bg++) {
        if (bpps[bg] && ((this.tm|this.ts)&(1<<bg)))
          this._buildBGLine(bg, y, bpps[bg]);
        else
          this._bgLine[bg].fill(0);
      }
    }
    if ((this.tm|this.ts)&0x10) this._buildObjLine(y);
    else this._objLine.fill(-1);

    // ウィンドウロジック抽出
    const bgsel = this.w12sel;        // [BG1sel, BG2sel, BG3sel, BG4sel]
    const bglog = this.wbglog;        // $212A: 2bit per BG
    const objsel = this.wobjsel & 0xF;
    const objlog = (this.wobjlog >> 0) & 3;

    const doColorMath = (this.cgadsub & 0x3F) !== 0;

    // cgwsel bits:
    //   bit1: sub screen source (0=sub screen, 1=fixed color)
    //   bit4-5: main black clip (force main to 0 in/outside window)
    const forceMainBlack = (this.cgwsel >> 6) & 3; // 0=never, 1=outside win, 2=inside win, 3=always

    for (let x = 0; x < 256; x++) {
      // ウィンドウマスク計算 (各レイヤー)
      // BG1-4: w12sel[i] = (W2inv<<3 | W2en<<2 | W1inv<<1 | W1en<<0)
      const bg1win = this._winMask(x, bgsel[0], (bglog>>0)&3);
      const bg2win = this._winMask(x, bgsel[1], (bglog>>2)&3);
      const bg3win = this._winMask(x, bgsel[2], (bglog>>4)&3);
      const bg4win = this._winMask(x, bgsel[3], (bglog>>6)&3);
      const objwin = this._winMask(x, objsel,   (this.wobjlog>>0)&3);

      let mainCI = 0, subCI = 0;
      let mainIsObj = false, subFound = false;
      let mainLayerBit = 1; // bit0=BDR, bit1=BG1, bit2=BG2, bit3=BG3, bit4=BG4, bit5=OBJ

      // ---- 優先度合成 (低→高で上書き) ----
      // No$SNES Mode1 (M1BG3=0): BG3P0, OBJ0, BG3P1, OBJ1, BG2P0, BG1P0, OBJ2, BG2P1, BG1P1, OBJ3
      // No$SNES Mode1 (M1BG3=1): BG3P0, OBJ0, BG2P0, BG1P0, OBJ1, BG2P1, BG1P1, OBJ2, BG3P1, OBJ3
      const m1bg3hi = (mode === 1) && !!(this.bgmode & 8);
      // BG4
      {const v=this._bgLine[3][x];if(v){const ci=v>>1;
        if(this.ts&8&&!subFound&&!(this.tsw&8&&bg4win)){subCI=ci;subFound=true;}
        if(this.tm&8&&!(this.tmw&8&&bg4win)){mainCI=ci;mainLayerBit=16;}}}
      // BG3 pri=0
      {const v=this._bgLine[2][x];if(v&&!(v&1)){const ci=v>>1;
        if(this.ts&4&&!subFound&&!(this.tsw&4&&bg3win)){subCI=ci;subFound=true;}
        if(this.tm&4&&!(this.tmw&4&&bg3win)){mainCI=ci;mainLayerBit=8;}}}
      // OBJ pri=0
      {const oci=this._objLine[x];if(oci>=0&&this._objPri[x]===0){
        if(this.ts&0x10&&!subFound&&!(this.tsw&0x10&&objwin)){subCI=oci;subFound=true;}
        if(this.tm&0x10&&!(this.tmw&0x10&&objwin)){mainCI=oci;mainIsObj=true;mainLayerBit=32;}}}
      // BG3 pri=1 (M1BG3=0 のみここで処理; M1BG3=1 は後段)
      if(!m1bg3hi){const v=this._bgLine[2][x];if(v&&(v&1)){const ci=v>>1;
        if(this.ts&4&&!subFound&&!(this.tsw&4&&bg3win)){subCI=ci;subFound=true;}
        if(this.tm&4&&!(this.tmw&4&&bg3win)){mainCI=ci;mainLayerBit=8;}}}
      // OBJ pri=1
      {const oci=this._objLine[x];if(oci>=0&&this._objPri[x]===1){
        if(this.ts&0x10&&!subFound&&!(this.tsw&0x10&&objwin)){subCI=oci;subFound=true;}
        if(this.tm&0x10&&!(this.tmw&0x10&&objwin)){mainCI=oci;mainIsObj=true;mainLayerBit=32;}}}
      // BG2 pri=0
      {const v=this._bgLine[1][x];if(v&&!(v&1)){const ci=v>>1;
        if(this.ts&2&&!subFound&&!(this.tsw&2&&bg2win)){subCI=ci;subFound=true;}
        if(this.tm&2&&!(this.tmw&2&&bg2win)){mainCI=ci;mainLayerBit=4;}}}
      // BG1 pri=0
      {const v=this._bgLine[0][x];if(v&&!(v&1)){const ci=v>>1;
        if(this.ts&1&&!subFound&&!(this.tsw&1&&bg1win)){subCI=ci;subFound=true;}
        if(this.tm&1&&!(this.tmw&1&&bg1win)){mainCI=ci;mainLayerBit=2;}}}
      // OBJ pri=2
      {const oci=this._objLine[x];if(oci>=0&&this._objPri[x]===2){
        if(this.ts&0x10&&!subFound&&!(this.tsw&0x10&&objwin)){subCI=oci;subFound=true;}
        if(this.tm&0x10&&!(this.tmw&0x10&&objwin)){mainCI=oci;mainIsObj=true;mainLayerBit=32;}}}
      // BG2 pri=1
      {const v=this._bgLine[1][x];if(v&&(v&1)){const ci=v>>1;
        if(this.ts&2&&!subFound&&!(this.tsw&2&&bg2win)){subCI=ci;subFound=true;}
        if(this.tm&2&&!(this.tmw&2&&bg2win)){mainCI=ci;mainLayerBit=4;}}}
      // BG1 pri=1
      {const v=this._bgLine[0][x];if(v&&(v&1)){const ci=v>>1;
        if(this.ts&1&&!subFound&&!(this.tsw&1&&bg1win)){subCI=ci;subFound=true;}
        if(this.tm&1&&!(this.tmw&1&&bg1win)){mainCI=ci;mainLayerBit=2;}}}
      // BG3 pri=1 (M1BG3=1 のみここで処理; OBJ2より上、OBJ3より下)
      if(m1bg3hi){const v=this._bgLine[2][x];if(v&&(v&1)){const ci=v>>1;
        if(this.ts&4&&!subFound&&!(this.tsw&4&&bg3win)){subCI=ci;subFound=true;}
        if(this.tm&4&&!(this.tmw&4&&bg3win)){mainCI=ci;mainLayerBit=8;}}}
      // OBJ pri=3 (最前面)
      {const oci=this._objLine[x];if(oci>=0&&this._objPri[x]===3){
        if(this.ts&0x10&&!subFound&&!(this.tsw&0x10&&objwin)){subCI=oci;subFound=true;}
        if(this.tm&0x10&&!(this.tmw&0x10&&objwin)){mainCI=oci;mainIsObj=true;mainLayerBit=32;}}}

      // ---- カラー演算 ----
      let r, g, b;

      // Force main black (cgwsel bits 6-7)
      const colwin = this._winMask(x, this.wcolsel, (this.wobjlog>>2)&3);
      const forceBlack = (forceMainBlack===1 && !colwin) ||
                         (forceMainBlack===2 &&  colwin) ||
                         (forceMainBlack===3);

      if (forceBlack) {
        r=g=b=0;
      } else if (doColorMath) {
        // cgadsub bits: bit0=BDR, bit1=BG1, bit2=BG2, bit3=BG3, bit4=BG4, bit5=OBJ
        // mainCI=0 はbackdrop(bit0), それ以外はmainLayerBitで判定
        const applyBit = mainCI === 0 ? 0 : (mainLayerBit === 32 ? 5 :
          mainLayerBit === 16 ? 4 : mainLayerBit === 8 ? 3 :
          mainLayerBit === 4 ? 2 : 1);
        if (this.cgadsub & (1 << applyBit)) {
          [r,g,b] = this._colorMath(mainCI, subCI, !subFound);
        } else {
          const c=this.cgram[mainCI&0xFF];
          const _r=((c)&0x1F),_g=((c>>5)&0x1F),_b=((c>>10)&0x1F);r=(_r<<3)|(_r>>2);g=(_g<<3)|(_g>>2);b=(_b<<3)|(_b>>2);
        }
      } else {
        const c=this.cgram[mainCI&0xFF];
        const _r=((c)&0x1F),_g=((c>>5)&0x1F),_b=((c>>10)&0x1F);r=(_r<<3)|(_r>>2);g=(_g<<3)|(_g>>2);b=(_b<<3)|(_b>>2);
      }

      const o = lineBase + x * 4;
      this.framebuf[o  ] = Math.round(r * brightness);
      this.framebuf[o+1] = Math.round(g * brightness);
      this.framebuf[o+2] = Math.round(b * brightness);
      this.framebuf[o+3] = 255;
    }
  }

  _blitToCanvas() {
    if (!this.ctx) return;
    this.imageData.data.set(this.framebuf);
    this.ctx.putImageData(this.imageData, 0, 0);
  }

  renderFrame() {
    for (let y=0;y<224;y++) this.renderScanline(y);
    this._blitToCanvas();
    this.frameCount++;
  }
}
