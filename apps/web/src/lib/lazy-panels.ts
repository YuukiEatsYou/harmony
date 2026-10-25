import { lazy } from './lazy';

/*
 * The panels that are kept out of the first download, in one place so it is
 * plain what is split off. Each becomes its own chunk, fetched when it is first
 * opened and drawn through LazyPanel.svelte.
 *
 * Only what most visits never open belongs here: the admin panel (staff only),
 * the setup wizard (once per instance), a member's own account settings, the
 * full profile viewer, events, scheduled messages and the media gallery.
 * Anything opened on most visits, such as search or the mentions inbox, stays in
 * the app, since splitting it would make the common case wait for no saving.
 *
 * The loaders live in a module rather than in the component that mounts them so
 * a panel fetched once stays fetched when that component is torn down and built
 * again, as Chat.svelte is on signing out and back in.
 */

export const adminPanel = lazy(() => import('../components/admin/AdminPanel.svelte'));
export const setupWizard = lazy(() => import('../components/SetupWizard.svelte'));
export const profilePanel = lazy(() => import('../components/ProfilePanel.svelte'));
export const profileViewer = lazy(() => import('../components/ProfileViewer.svelte'));
export const eventsPanel = lazy(() => import('../components/EventsPanel.svelte'));
export const scheduledPanel = lazy(() => import('../components/ScheduledPanel.svelte'));
export const galleryPanel = lazy(() => import('../components/GalleryPanel.svelte'));
