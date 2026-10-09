import type { Channel, User } from '@harmony/shared';
import type { AdminTabId } from './admin';

class UiState {
  adminOpen = $state(false);
  /** The tab to select when the admin panel next opens. */
  adminTab = $state<AdminTabId>('settings');
  aboutOpen = $state(false);
  profileOpen = $state(false);
  searchOpen = $state(false);
  inboxOpen = $state(false);
  pinsOpen = $state(false);
  savedOpen = $state(false);
  scheduledOpen = $state(false);
  eventsOpen = $state(false);
  /** The channel whose media gallery is open, or null. */
  gallery: Channel | null = $state(null);
  /** The member whose full profile viewer is open, or null. */
  profileViewerUser = $state<User | null>(null);
  /** Off-canvas navigation, used on narrow screens. */
  sidebarOpen = $state(false);
  rosterOpen = $state(false);

  openAbout(): void {
    this.closeDrawers();
    this.#closePanels();
    this.aboutOpen = true;
  }

  closeAbout(): void {
    this.aboutOpen = false;
  }

  openSearch(): void {
    this.closeDrawers();
    this.#closePanels();
    this.searchOpen = true;
  }

  closeSearch(): void {
    this.searchOpen = false;
  }

  openInbox(): void {
    this.closeDrawers();
    this.#closePanels();
    this.inboxOpen = true;
  }

  closeInbox(): void {
    this.inboxOpen = false;
  }

  openPins(): void {
    this.closeDrawers();
    this.#closePanels();
    this.pinsOpen = true;
  }

  closePins(): void {
    this.pinsOpen = false;
  }

  openSaved(): void {
    this.closeDrawers();
    this.#closePanels();
    this.savedOpen = true;
  }

  closeSaved(): void {
    this.savedOpen = false;
  }

  openScheduled(): void {
    this.closeDrawers();
    this.#closePanels();
    this.scheduledOpen = true;
  }

  closeScheduled(): void {
    this.scheduledOpen = false;
  }

  openEvents(): void {
    this.closeDrawers();
    this.#closePanels();
    this.eventsOpen = true;
  }

  closeEvents(): void {
    this.eventsOpen = false;
  }

  /** Opens one channel's media gallery. The channel need not be the open one. */
  openGallery(channel: Channel): void {
    this.closeDrawers();
    this.#closePanels();
    this.gallery = channel;
  }

  closeGallery(): void {
    this.gallery = null;
  }

  openAdmin(tab: AdminTabId = 'settings'): void {
    this.closeDrawers();
    this.#closePanels();
    this.adminTab = tab;
    this.adminOpen = true;
  }

  closeAdmin(): void {
    this.adminOpen = false;
  }

  openProfile(): void {
    this.closeDrawers();
    this.#closePanels();
    this.profileOpen = true;
  }

  closeProfile(): void {
    this.profileOpen = false;
  }

  /** Opens the big, fixed profile viewer for one member. */
  openProfileViewer(user: User): void {
    this.closeDrawers();
    this.#closePanels();
    this.profileViewerUser = user;
  }

  closeProfileViewer(): void {
    this.profileViewerUser = null;
  }

  /**
   * Only one modal panel is ever open at once, so opening any of them closes
   * the rest, however they were reached. Bumping a panel through the console or
   * another asynchronous path cannot leave two overlays stacked.
   */
  #closePanels(): void {
    this.aboutOpen = false;
    this.adminOpen = false;
    this.profileOpen = false;
    this.searchOpen = false;
    this.inboxOpen = false;
    this.pinsOpen = false;
    this.savedOpen = false;
    this.scheduledOpen = false;
    this.eventsOpen = false;
    this.gallery = null;
    this.profileViewerUser = null;
  }

  /** Only one drawer is ever open, so they never overlap. */
  toggleSidebar(): void {
    this.sidebarOpen = !this.sidebarOpen;
    this.rosterOpen = false;
  }

  toggleRoster(): void {
    this.rosterOpen = !this.rosterOpen;
    this.sidebarOpen = false;
  }

  closeDrawers(): void {
    this.sidebarOpen = false;
    this.rosterOpen = false;
  }
}

export const ui = new UiState();
