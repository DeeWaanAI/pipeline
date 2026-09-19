declare module "adm-zip" {
  interface ZipEntry {
    entryName: string;
    isDirectory: boolean;
    header: { size: number };
    getData(): Buffer;
  }

  class AdmZip {
    constructor(buffer?: Buffer | string);
    getEntries(): ZipEntry[];
    extractAllTo(targetPath: string, overwrite?: boolean): void;
    readFile(entryName: string): Buffer;
    readAsText(entryName: string): string;
  }

  export = AdmZip;
}
