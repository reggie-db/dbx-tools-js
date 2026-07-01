import { apiUtils, cloudUtils } from "@dbx-tools/shared";
import {
  ZerobusSdk,
  type RecordType,
  type StreamConfigurationOptions,
  type TableProperties,
  type ZerobusStream,
} from "@databricks/zerobus-ingest-sdk";

export async function createSdk(): Promise<ZerobusSdk> {
  const workspaceUrl = await apiUtils.getWorkspaceUrl();
  if (!workspaceUrl) {
    throw new Error("Workspace URL not found");
  }
  const workspaceId = await apiUtils.getWorkspaceId();
  if (!workspaceId) {
    throw new Error(`Workspace ID not found: workspaceUrl=${workspaceUrl.toString()}`);
  }
  const location = await cloudUtils.resolveCloudLocation(workspaceUrl.toString());
  if (!location) {
    throw new Error(
      `Workspace location not found: workspaceUrl=${workspaceUrl.toString()}`,
    );
  }
  const domain =
    location.provider === cloudUtils.CloudProvider.Azure
      ? "azuredatabricks.net"
      : "cloud.databricks.com";
  const zerobusEndpoint = `https://${workspaceId}.zerobus.${location.region}.${domain}`;
  return new ZerobusSdk(zerobusEndpoint, workspaceUrl.toString());
}

export async function createStream(
  sdk: ZerobusSdk,
  table: TableProperties | string,
  options?: StreamConfigurationOptions,
): Promise<ZerobusStream> {
  function resolveVariable(name: string): string {
    for (const candidate of [`ZEROBUS_${name}`, name]) {
      const value = process.env[candidate];
      if (value) {
        return value;
      }
    }
    throw new Error(`Variable ${name} not found`);
  }
  const streamTableProperties =
    typeof table === "string" ? { tableName: table } : table;
  const streamClientId = resolveVariable("DATABRICKS_CLIENT_ID");
  const streamClientSecret = resolveVariable("DATABRICKS_CLIENT_SECRET");
  const streamOptions = {
    recovery: true,
    recordType: 0 as RecordType, // RecordType.Json (const enum, can't be referenced under verbatimModuleSyntax)
    ...options,
  };
  return await sdk.createStream(
    streamTableProperties,
    streamClientId,
    streamClientSecret,
    streamOptions,
  );
}
