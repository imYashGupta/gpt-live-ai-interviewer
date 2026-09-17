import type { Metadata } from "next";
import Join from "./join";
export const metadata: Metadata = {
  title: "Your interview",
  description: "Join your scheduled audio interview.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export default function Page() {
  return <Join />;
}
