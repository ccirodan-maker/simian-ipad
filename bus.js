// ============================================================
// bus.js  v6  ―  SFC 24bit メモリバス (LoROM)
//   Bug Fixes:
//   - HDMA/DMA レジスタマッピングの修正 (43x5-43x9)
//   - DMA 転送時のバンク境界ラップアラウンド修正
//   - DMA レジスタからの読み取り (Open Bus 回避)
// ============================================================
class Bus {
  constructor(cart) {
    this.cart = cart;
    this.ppu  = null;
    this.cpu  = null;
    this.apu  = null;

    this.wram = new Uint8Array(0x20000);

    this.nmitimen  = 0x00;
    this.rdnmi     = 0x00;
    this._timeup   = 0x00;
    this.hvbjoy    = 0x00;

    this.htime = 0x1FF;
    this.vtime = 0x1FF;

    this.joy1raw  = 0;
    this.joy2raw  = 0;
    this._joy1Lat = 0;
    this._joy2Lat = 0;
    this._joy1Bit = 0;
    this._joy2Bit = 0;
    this._joyStrobe  = false;
    this._autoJoyBusy = 0;

    this._wrmpya = 0xFF;
    this._wrdivl = 0;
    this._wrdivh = 0;
    this._rdmpy  = 0;
    this._rddiv  = 0;

    this._wramAddr = 0;

    this._dma = Array.from({length:8}, () => ({
      ctrl:0, destReg:0, srcBank:0, srcAddr:0, byteCount:0,
      hdmaCtrl:0, hdmaTableBank:0, hdmaTableAddr:0,
      hdmaLineCount:0, hdmaIndBank:0, hdmaIndAddr:0, hdmaDo:false,
      hdmaInitAddr:0, hdmaInitBank:0, _hdmaRepeatAddr:0
    }));
    this._hdmaMask = 0;
    this._openBus  = 0;
  }

  // ================================================================
  //  READ  (24bit アドレス)
  // ================================================================
  read(addr24) {
    addr24 &= 0xFFFFFF;
    const bank = (addr24 >> 16) & 0xFF;
    const off  =  addr24 & 0xFFFF;
    let val;

    if (bank === 0x7E || bank === 0x7F) {
      val = this.wram[((bank & 1) << 16) | off];
    } else if (bank >= 0x70 && bank <= 0x7D && off < 0x8000) {
      val = this.cart.readSRAM(bank, off);
    } else if ((bank >= 0x40 && bank <= 0x7D) ||
               (bank >= 0xC0 && bank <= 0xFF)) {
      val = this.cart.readROM(bank, off);
    } else {
      if (off <= 0x1FFF)                       val = this.wram[off & 0x1FFF];
      else if (off >= 0x2140 && off <= 0x2143) val = this.apu ? this.apu.read(off-0x2140) : this._openBus;
      else if (off >= 0x2100 && off <= 0x21FF) val = this._readPPU(off);
      else if (off === 0x2180)                 val = this.wram[this._wramAddr++ & 0x1FFFF];
      else if (off === 0x4016)                 val = this._readJoy1();
      else if (off === 0x4017)                 val = this._readJoy2();
      else if (off >= 0x4200 && off <= 0x44FF) val = this._readIO(off);
      else if (off >= 0x8000)                  val = this.cart.readROM(bank, off);
      else                                     val = this._openBus;
    }

    this._openBus = val & 0xFF;
    return this._openBus;
  }

  // ================================================================
  //  WRITE
  // ================================================================
  write(addr24, val) {
    addr24 &= 0xFFFFFF;
    val &= 0xFF;
    const bank = (addr24 >> 16) & 0xFF;
    const off  =  addr24 & 0xFFFF;

    if (bank === 0x7E || bank === 0x7F)
      { this.wram[((bank & 1) << 16) | off] = val; return; }
    if (bank >= 0x70 && bank <= 0x7D && off < 0x8000)
      { this.cart.writeSRAM(bank, off, val); return; }
    if ((bank >= 0x40 && bank <= 0x7D) || (bank >= 0xC0 && bank <= 0xFF))
      return;

    if (off <= 0x1FFF)                     { this.wram[off & 0x1FFF] = val; return; }
    if (off >= 0x2140 && off <= 0x2143)    { if (this.apu) this.apu.write(off-0x2140, val); return; }
    if (off >= 0x2100 && off <= 0x21FF)    { this._writePPU(off, val); return; }
    if (off === 0x2180) { this.wram[this._wramAddr++ & 0x1FFFF] = val; return; }
    if (off === 0x2181) { this._wramAddr = (this._wramAddr & 0x1FF00) | val; return; }
    if (off === 0x2182) { this._wramAddr = (this._wramAddr & 0x100FF) | (val << 8); return; }
    if (off === 0x2183) { this._wramAddr = (this._wramAddr & 0x0FFFF) | ((val & 1) << 16); return; }
    if (off === 0x4016) { this._writeJoyLatch(val); return; }
    if (off >= 0x4200 && off <= 0x44FF) { this._writeIO(off, val); return; }
  }

  _readPPU(o)     { return this.ppu ? this.ppu.read(o) : this._openBus; }
  _writePPU(o, v) { if (this.ppu) this.ppu.write(o, v); }

  // ================================================================
  //  ジョイパッド
  // ================================================================
  _writeJoyLatch(val) {
    const strobe = !!(val & 1);
    if (!strobe && this._joyStrobe) {
      this._joy1Bit = 0; this._joy2Bit = 0;
      this._joy1Lat = this.joy1raw; this._joy2Lat = this.joy2raw;
    }
    this._joyStrobe = strobe;
  }
  _readJoy1() {
    if (this._joyStrobe) return 0x40 | (this.joy1raw >> 15);
    return 0x40 | ((this._joy1Lat >> (15 - Math.min(this._joy1Bit++, 15))) & 1);
  }
  _readJoy2() {
    if (this._joyStrobe) return 0x40 | (this.joy2raw >> 15);
    return 0x40 | ((this._joy2Lat >> (15 - Math.min(this._joy2Bit++, 15))) & 1);
  }

  // ================================================================
  //  CPU I/O
  // ================================================================
  _readIO(off) {
    if (off >= 0x4300 && off <= 0x437F) return this._readDMAReg(off);
    switch (off) {
      case 0x4210: { const v = this.rdnmi | 0x02; this.rdnmi = 0; return v; }
      case 0x4211: { const v = this._timeup; this._timeup = 0; if(this.cpu)this.cpu.irqPending=false; return v; }
      case 0x4212: return this.hvbjoy;
      case 0x4213: return 0; // IO Port
      case 0x4214: return  this._rddiv & 0xFF;
      case 0x4215: return (this._rddiv >> 8) & 0xFF;
      case 0x4216: return  this._rdmpy & 0xFF;
      case 0x4217: return (this._rdmpy >> 8) & 0xFF;
      case 0x4218: return  this._joy1Lat & 0xFF;
      case 0x4219: return (this._joy1Lat >> 8) & 0xFF;
      case 0x421A: return  this._joy2Lat & 0xFF;
      case 0x421B: return (this._joy2Lat >> 8) & 0xFF;
      default: return this._openBus;
    }
  }

  _writeIO(off, val) {
    if (off >= 0x4300 && off <= 0x437F) { this._writeDMAReg(off, val); return; }
    switch (off) {
      case 0x4200: this.nmitimen = val; break;
      case 0x4202: this._wrmpya = val; break;
      case 0x4203: this._rdmpy = (this._wrmpya * val) & 0xFFFF; break;
      case 0x4204: this._wrdivl = val; break;
      case 0x4205: this._wrdivh = val; break;
      case 0x4206: {
        const d = this._wrdivl | (this._wrdivh << 8);
        this._rddiv = val ? (Math.floor(d / val) & 0xFFFF) : 0xFFFF;
        this._rdmpy = val ? (d % val) : d;
        break;
      }
      case 0x4207: this.htime = (this.htime & 0x100) | val; break;
      case 0x4208: this.htime = (this.htime & 0x0FF) | ((val&1)<<8); break;
      case 0x4209: this.vtime = (this.vtime & 0x100) | val; break;
      case 0x420A: this.vtime = (this.vtime & 0x0FF) | ((val&1)<<8); break;
      case 0x420B: this._execDMA(val); break;
      case 0x420C: this._hdmaMask = val; break;
    }
  }

  // ================================================================
  //  DMA & HDMA
  // ================================================================
  _readDMAReg(off) {
    const ch = (off >> 4) & 7, d = this._dma[ch];
    switch (off & 0xF) {
      case 0x0: return d.ctrl;
      case 0x1: return d.destReg & 0xFF;
      case 0x2: return d.srcAddr & 0xFF;
      case 0x3: return (d.srcAddr >> 8) & 0xFF;
      case 0x4: return d.srcBank;
      case 0x5: return d.byteCount & 0xFF; // aliases hdmaIndAddr
      case 0x6: return (d.byteCount >> 8) & 0xFF;
      case 0x7: return d.hdmaIndBank;
      case 0x8: return d.hdmaTableAddr & 0xFF;
      case 0x9: return (d.hdmaTableAddr >> 8) & 0xFF;
      case 0xA: return d.hdmaLineCount;
      default: return this._openBus;
    }
  }

  _writeDMAReg(off, val) {
    const ch = (off >> 4) & 7, d = this._dma[ch];
    switch (off & 0xF) {
      case 0x0: d.ctrl=val; d.hdmaCtrl=val; break;
      case 0x1: d.destReg=0x2100|val; break;
      case 0x2: d.srcAddr=(d.srcAddr&0xFF00)|val; d.hdmaInitAddr=(d.hdmaInitAddr&0xFF00)|val; break;
      case 0x3: d.srcAddr=(d.srcAddr&0x00FF)|(val<<8); d.hdmaInitAddr=(d.hdmaInitAddr&0x00FF)|(val<<8); break;
      case 0x4: d.srcBank=val; d.hdmaInitBank=val; break;
      case 0x5: d.byteCount=(d.byteCount&0xFF00)|val; d.hdmaIndAddr=(d.hdmaIndAddr&0xFF00)|val; break;
      case 0x6: d.byteCount=(d.byteCount&0x00FF)|(val<<8); d.hdmaIndAddr=(d.hdmaIndAddr&0x00FF)|(val<<8); break;
      case 0x7: d.hdmaIndBank=val; break;
      case 0x8: d.hdmaTableAddr=(d.hdmaTableAddr&0xFF00)|val; break;
      case 0x9: d.hdmaTableAddr=(d.hdmaTableAddr&0x00FF)|(val<<8); break;
      case 0xA: d.hdmaLineCount=val; break;
    }
  }

  _execDMA(mask) {
    const seqs=[[0],[0,1],[0,0],[0,0,1,1],[0,1,2,3],[0,1,0,1],[0,0],[0,0,1,1]];
    for (let ch=0;ch<8;ch++) {
      if (!(mask&(1<<ch))) continue;
      const d=this._dma[ch];
      const seq=seqs[d.ctrl&7];
      const fix=(d.ctrl>>3)&1, dec=(d.ctrl>>4)&1, rev=(d.ctrl>>7)&1;
      let size=d.byteCount||0x10000;
      for (let i=0;i<size;i++) {
        const dst = d.destReg + seq[i%seq.length];
        const src = (d.srcBank << 16) | d.srcAddr;
        rev ? this.write(src, this.read(dst)) : this.write(dst, this.read(src));
        if (!fix) d.srcAddr = (d.srcAddr + (dec ? -1 : 1)) & 0xFFFF; // Bank must not cross!
      }
      d.byteCount = 0;
    }
  }

  startFrame() {
    if (!this._hdmaMask) return;
    for (let ch=0;ch<8;ch++) {
      if (!(this._hdmaMask&(1<<ch))) continue;
      const d=this._dma[ch];
      d.hdmaTableAddr=d.hdmaInitAddr; d.hdmaTableBank=d.hdmaInitBank;
      d.hdmaLineCount=0; d.hdmaDo=true;
    }
  }

  runHDMA() {
    if (!this._hdmaMask) return;
    const seqs=[[0],[0,1],[0,0],[0,0,1,1],[0,1,2,3],[0,1,0,1],[0,0],[0,0,1,1]];
    for (let ch=0;ch<8;ch++) {
      if (!(this._hdmaMask&(1<<ch))) continue;
      const d=this._dma[ch]; if(!d.hdmaDo) continue;
      
      if ((d.hdmaLineCount&0x7F)===0) {
        const entry=this.read((d.hdmaTableBank<<16)|d.hdmaTableAddr);
        d.hdmaTableAddr=(d.hdmaTableAddr+1)&0xFFFF;
        if(entry===0){d.hdmaDo=false;continue;}
        
        d.hdmaLineCount=entry;
        if(d.hdmaCtrl&0x40){
          // indirect: read 16bit pointer
          d.hdmaIndAddr = this.read((d.hdmaTableBank<<16)|d.hdmaTableAddr) |
                         (this.read((d.hdmaTableBank<<16)|((d.hdmaTableAddr+1)&0xFFFF))<<8);
          d.hdmaTableAddr=(d.hdmaTableAddr+2)&0xFFFF;
        }
        
        if(d.hdmaLineCount&0x80){
          d._hdmaRepeatAddr = (d.hdmaCtrl&0x40) ? d.hdmaIndAddr : d.hdmaTableAddr;
        }
      } else if(d.hdmaLineCount&0x80) {
        if(d.hdmaCtrl&0x40) d.hdmaIndAddr = d._hdmaRepeatAddr;
        else d.hdmaTableAddr = d._hdmaRepeatAddr;
      }
      
      const seq=seqs[d.hdmaCtrl&7], indir=(d.hdmaCtrl&0x40)!==0;
      for (let i=0;i<seq.length;i++) {
        let sa;
        if(indir){sa=(d.hdmaIndBank<<16)|d.hdmaIndAddr;d.hdmaIndAddr=(d.hdmaIndAddr+1)&0xFFFF;}
        else{sa=(d.hdmaTableBank<<16)|d.hdmaTableAddr;d.hdmaTableAddr=(d.hdmaTableAddr+1)&0xFFFF;}
        this.write(d.destReg+seq[i],this.read(sa));
      }
      
      d.hdmaLineCount = (d.hdmaLineCount & 0x80) | (((d.hdmaLineCount & 0x7F) - 1) & 0x7F);
    }
  }

  // ================================================================
  //  タイミング
  // ================================================================
  updateTiming(scanline) {
    this.hvbjoy = 0;
    if (scanline >= 225) {
      this.hvbjoy |= 0x80;
      if (scanline === 225) {
        if (this.nmitimen & 0x80) {
          this.rdnmi = 0x80;
          if (this.cpu) this.cpu.nmiPending = true;
        }
        if (this.nmitimen & 0x01) {
          this._joy1Lat = this.joy1raw; this._joy2Lat = this.joy2raw;
          this._joy1Bit = 0; this._joy2Bit = 0;
          this._autoJoyBusy = 4;
        }
        if (this.ppu) this.ppu.oamadd = (this.ppu._oamReload << 1) & 0x3FF;
      }
    }
    if (this._autoJoyBusy > 0) { this.hvbjoy |= 0x01; this._autoJoyBusy--; }
    if (scanline < 225 && this._hdmaMask) this.runHDMA();

    const irqMode = (this.nmitimen >> 4) & 3;
    if (irqMode === 2 && scanline === this.vtime) {
      this._timeup = 0x80;
      if (this.cpu && !this.cpu.flagI) this.cpu.irqPending = true;
    } else if (irqMode === 3 && scanline === this.vtime) {
      this._timeup = 0x80;
      if (this.cpu && !this.cpu.flagI) this.cpu.irqPending = true;
    }
  }
}