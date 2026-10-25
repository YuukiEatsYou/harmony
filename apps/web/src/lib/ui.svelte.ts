import { MediaQuery } from 'svelte/reactivity';
import type { Channel, User } from '@harmony/shared';
import type { AdminTabId } from './admin';
import { lightbox } from './lightbox.svelte';
import { modalLayers } from './modal-layers.svelte';
import { shortcuts } from './shortcuts.svelte';

/**
 * The narrow layout, where the channel and member lists become drawers. The
 * width is the one the mobile block of app.css switches on; the two must agree.
 */
const narrowLayout = new MediaQuery('(max-width: 768px)');

/*
 * Whether the member list is put away on a wide screen, remembered per browser.
 * It is only a matter of how this one viewer likes the window laid out, so it
 * never goes near the server, and storage that refuses (a private window,
 * blocked site data) just means the list starts out shown.
 */
const membersHiddenKey = 'harmony.membersHidden';

function readMembersHidden(): boolean {
  try {
    return localStorage.getItem(membersHiddenKey) === '1';
  } catch {
    return false;
  }
}

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
  /**
   * The member list put away on a wide screen. A narrow screen ignores it: there
   * the list is the drawer above, which starts closed whatever this says.
   */
  membersHidden = $state(readMembersHidden());

  /** Whether the layout is the narrow one, with drawers for the side lists. */
  get narrow(): boolean {
    return narrowLayout.current;
  }

  /** Whether the member list is on screen, whichever form it takes at this width. */
  get membersShown(): boolean {
    return this.narrow ? this.rosterOpen : !this.membersHidden;
  }
  /** The owner's first-run setup wizard, which App opens while setup is not done. */
  setupOpen = $state(false);

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

  /**
   * Shows or hides the member list the way the screen has it: the drawer on a
   * narrow one, the remembered choice on a wide one. The members button and
   * Ctrl+U both come here, so they never disagree about which applies.
   */
  toggleMembers(): void {
    if (this.narrow) {
      this.toggleRoster();
      return;
    }
    this.membersHidden = !this.membersHidden;
    try {
      if (this.membersHidden) localStorage.setItem(membersHiddenKey, '1');
      else localStorage.removeItem(membersHiddenKey);
    } catch {
      // Remembered for this visit only.
    }
  }

  closeDrawers(): void {
    this.sidebarOpen = false;
    this.rosterOpen = false;
  }

  /**
   * What Escape does over the chat: closes the open panel or drawer. The setup
   * wizard is left alone, since it is finished or skipped with its own buttons
   * rather than put away with a stray key.
   */
  dismissPanel(): void {
    this.closeDrawers();
    this.#closePanels();
  }

  /**
   * Leaves the setup wizard for now. It is not marked done, so it greets the
   * owner again next time; only its own last step and "Skip setup" finish it.
   */
  closeSetup(): void {
    this.setupOpen = false;
  }

  /**
   * Closes every drawer and panel, and the setup wizard, for a jump or a step
   * that changes the channel under them.
   */
  closeAll(): void {
    this.closeDrawers();
    this.#closePanels();
    this.setupOpen = false;
  }

  /**
   * How many layers are open over the chat: the drawers, panels and setup
   * wizard count as one, the quick switcher or shortcut help as another, the
   * dialogs that register themselves (edit history, "What's new") as a third,
   * and the lightbox as a fourth. This is the one place that answers "is anything
   * open over the chat", which is what decides whether back closes something
   * or changes channel. A choice of layout, such as hiding the member list on
   * a wide screen, is not something open over the chat and does not count.
   */
  get overlayDepth(): number {
    return this.#overlays().filter((layer) => layer.open).length;
  }

  /**
   * Closes what is open over the chat from the top down until no more than
   * `depth` layers are left, so a step back from a picture opened in the gallery
   * closes the picture and leaves the gallery, as Escape does. Zero closes all.
   */
  closeOverlaysAbove(depth: number): void {
    const open = this.#overlays().filter((layer) => layer.open);
    for (const layer of open.slice(0, Math.max(0, open.length - depth))) layer.close();
  }

  /**
   * The layers, topmost first, in the order they stack on screen: the
   * lightbox is drawn over everything, and the keyboard dialogs over the panels.
   * Only one panel or drawer is ever open, so together they are one layer.
   */
  #overlays(): { open: boolean; close: () => void }[] {
    return [
      { open: lightbox.url !== null, close: () => lightbox.close() },
      { open: modalLayers.count > 0, close: () => modalLayers.closeAll() },
      { open: shortcuts.panel !== null, close: () => void shortcuts.close() },
      { open: this.#ownOpen(), close: () => this.closeAll() },
    ];
  }

  #ownOpen(): boolean {
    return (
      // A drawer is only drawn on a narrow screen. One left open as the window
      // widens, or a tablet turns, is out of sight and does not count, or back
      // would spend a press closing it.
      (this.narrow && (this.sidebarOpen || this.rosterOpen)) ||
      this.setupOpen ||
      this.aboutOpen ||
      this.adminOpen ||
      this.profileOpen ||
      this.searchOpen ||
      this.inboxOpen ||
      this.pinsOpen ||
      this.savedOpen ||
      this.scheduledOpen ||
      this.eventsOpen ||
      this.gallery !== null ||
      this.profileViewerUser !== null
    );
  }
}

export const ui = new UiState();
