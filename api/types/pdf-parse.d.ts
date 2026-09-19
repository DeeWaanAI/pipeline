declare module "pdf-parse" {
  interface PdfParseResult {
    text: string;
    numpages: number;
    numrender: number;
    info: Record<string, unknown>;
    metadata: Record<string, unknown> | null;
    version: string;
  }

  function pdfParse(dataBuffer: Buffer | Uint8Array, options?: { max?: number; version?: string }): Promise<PdfParseResult>;

  export = pdfParse;
}
