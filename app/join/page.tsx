import type { Metadata } from "next";
import Join from "./join";
export const metadata: Metadata = {
  title: "Your AI interview",
  description: "Join your scheduled AI interview.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export default function Page() {
  return <Join />;
}
