import { PasscodeForm } from "@/components/passcode-form";
import {
  getConfiguredPasscode,
  sanitizeReturnPath,
} from "@/lib/access-control";

interface AccessPageProps {
  searchParams: Promise<{
    next?: string | string[];
  }>;
}

export default async function AccessPage({ searchParams }: AccessPageProps) {
  const values = await searchParams;

  return (
    <PasscodeForm
      nextPath={sanitizeReturnPath(values.next)}
      configurationMissing={!getConfiguredPasscode()}
    />
  );
}
