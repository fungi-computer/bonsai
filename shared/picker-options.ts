/** Bonsai picker methods share Gills' maintained placement and choice grammar. */
import * as Schema from "effect/Schema";
import * as z from "zod";
import {
  gillParamsSchema,
  gillOptionsResponseSchema,
} from "@fungi.computer/gills";

const decodeParams = Schema.decodeUnknownSync(gillParamsSchema, {
  onExcessProperty: "error",
});
const params = z
  .fromJSONSchema(Schema.toJsonSchemaDocument(gillParamsSchema).schema)
  .transform((value) => decodeParams(value));
export const pickerOptionsInput = z.strictObject({
  params,
  limit: z.number().int().min(1).max(200),
  after: z.string().max(1024).optional(),
});
export type PickerOptionsInput = z.output<typeof pickerOptionsInput>;
export const pickerOptionsPage = z.fromJSONSchema(
  Schema.toJsonSchemaDocument(gillOptionsResponseSchema).schema,
);
