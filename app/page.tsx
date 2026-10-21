import TruthLensApp from "@/components/TruthLensApp";
import { getSession } from "@/lib/session";

export default async function Home() {
  const session = await getSession();
  return <TruthLensApp initialUsername={session?.username ?? null} />;
}