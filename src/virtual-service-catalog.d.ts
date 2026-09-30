declare module "virtual:service-catalog" {
  import type { ServiceRecord, ServiceValidation } from "./types";

  export const catalogEntries: Array<{
    record: ServiceRecord;
    sourceFilePath: string;
    sourcePath: string;
  }>;

  export const initialValidation: Record<string, ServiceValidation>;
}
