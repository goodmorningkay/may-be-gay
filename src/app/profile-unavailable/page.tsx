import { notFound } from "next/navigation";

// The proxy rewrites missing profile documents here with a 404 status.
export default function ProfileUnavailable() {
  notFound();
}
