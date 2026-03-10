import { ulid } from "ulidx";

export function newId(): string {
  return ulid();
}
