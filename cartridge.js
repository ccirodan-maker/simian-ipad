// ============================================================
// cartridge.js  v5  ―  LoROM マッパー
//   Phase 5 修正: ROM バンクアドレスの正しいラップ処理
//
//   LoROM メモリマップ:
//     Banks $00-$3F / $80-$BF  : addr $8000-$FFFF → ROM
//     Banks $40-$7D / $C0-$FD  : addr $0000-$7FFF → ROM (lower half)
//                                addr $8000-$FFFF → ROM (upper half)
//   1MB ROM (16 banks × 64KB = 32 pages × 32KB) のアドレス計算:
//     page = (bank & 0x7F) % numPages    ← ここが重要：ラップ必須
//     offset = page * 0x8000 + (addr & 0x7FFF)
// ============================================================
class Cartridge {
  constructor(romData) {
    this.rom  = new Uint8Array(romData);
    this.sram = new Uint8Array(0x8000);   // 32KB SRAM
    this.sramDirty = false;               // 書き込み発生で立つ。自動保存ロジックで参照
    this.sramLastWriteAt = 0;             // 直近の書き込み時刻 (performance.now)

    // LoROM ヘッダ解析 (0x7FC0)
    this.title = '';
    for (let i = 0; i < 21; i++) {
      const c = this.rom[0x7FC0 + i];
      if (c >= 0x20 && c < 0x7F) this.title += String.fromCharCode(c);
    }
    this.romMakeup  = this.rom[0x7FD5];
    this.romType    = this.rom[0x7FD6];
    this.romSizeKB  = 1 << this.rom[0x7FD7];
    this.ramSizeKB  = this.rom[0x7FD8] ? (1 << this.rom[0x7FD8]) : 0;
    this.country    = this.rom[0x7FD9];
    this.version    = this.rom[0x7FDB];
    this.headerChecksum = this.rom[0x7FDE] | (this.rom[0x7FDF] << 8);
    this.headerCheckComplement = this.rom[0x7FDC] | (this.rom[0x7FDD] << 8);

    // ページ数 (32KB 単位)
    this._numPages = this.rom.length >> 15;  // 1MB = 32ページ
    if (this._numPages === 0) this._numPages = 1;
  }

  // LoROM 読み込み
  // bank : 0x00-0xFF (LoROM の全バンク)
  // addr : 0x0000-0xFFFF
  readROM(bank, addr) {
    // LoROM ページ番号 = (bank & 0x7F) % numPages でラップ
    const page   = (bank & 0x7F) % this._numPages;
    const offset = (page << 15) | (addr & 0x7FFF);
    return offset < this.rom.length ? this.rom[offset] : 0xFF;
  }

  // SRAM (バンク $70-$7D、アドレス $0000-$7FFF)
  readSRAM(bank, addr) {
    const off = ((bank - 0x70) & 0xF) * 0x8000 + (addr & 0x7FFF);
    return this.sram[off % this.sram.length];
  }
  writeSRAM(bank, addr, val) {
    const off = ((bank - 0x70) & 0xF) * 0x8000 + (addr & 0x7FFF);
    const idx = off % this.sram.length;
    const v = val & 0xFF;
    if (this.sram[idx] !== v) {
      this.sram[idx] = v;
      this.sramDirty = true;
      this.sramLastWriteAt = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    }
  }

  verifyChecksum() {
    let sum = 0;
    for (const b of this.rom) sum = (sum + b) & 0xFFFF;
    return sum === this.headerChecksum &&
           (this.headerChecksum ^ this.headerCheckComplement) === 0xFFFF;
  }
}
