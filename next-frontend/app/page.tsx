import { redirect } from "next/navigation";

/**
 * Placeholder root route.
 *
 * The real home — video listing, search, navigation — is a Phase 07 deliverable
 * (`docs/project-plan.md`). Until it exists, `/` sends visitors to the sign-in
 * screen so the app has a usable entry point.
 *
 * Deliberately a temporary 307 (`redirect`) and not a permanent 308
 * (`permanentRedirect`): browsers cache 308s, which would keep sending people to
 * /login even after Phase 07 ships the actual home. Remove this file's redirect
 * then — anonymous visitors are meant to browse videos without signing in.
 */
export default function Home() {
  redirect("/login");
}
