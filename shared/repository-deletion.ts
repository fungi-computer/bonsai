import * as z from "zod";

/** Successful deletion confirms both catalog withdrawal and provider cleanup. */
export const repositoryDeletion = z.strictObject({ deleted: z.literal(true) });
