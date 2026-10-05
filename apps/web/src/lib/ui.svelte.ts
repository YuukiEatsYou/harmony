class UiState {
  adminOpen = $state(false);
  aboutOpen = $state(false);
  profileOpen = $state(false);
  searchOpen = $state(false);
  inboxOpen = $state(false);
  pinsOpen = $state(false);
  savedOpen = $state(false);
  scheduledOpen = $state(false);
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

  openAdmin(): void {
    this.closeDrawers();
    this.#closePanels();
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
