import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useShallow } from "zustand/shallow";
import type { CalendarEvent, CalendarViewType, FilterState } from "@/lib/types";
import type { EventFormData } from "@/lib/validations";

interface CalendarState {
  // Client-only state (server state is now in TanStack Query)
  currentDate: Date;
  calendarView: CalendarViewType;
  hasUserSetView: boolean; // Track if user explicitly changed view (for smart defaulting)
  filter: FilterState;
  /**
   * Member ids this filter has already seen. Lets `syncMembers` tell a member
   * the user deliberately deselected from one that is genuinely new, so new
   * members become visible without resurrecting hidden ones.
   */
  knownMemberIds: string[];
  isAddEventModalOpen: boolean;
  /** User preference: hide the Day view mini-month rail even when it would fit. */
  dayRailHidden: boolean;
  toggleDayRail: () => void;
  addEventDefaults: Partial<EventFormData> | null;

  // Event detail modal state
  selectedEvent: CalendarEvent | null;
  isDetailModalOpen: boolean;

  // Edit modal state (separate from add)
  editingEvent: CalendarEvent | null;
  isEditModalOpen: boolean;

  // Navigation actions
  goToToday: () => void;
  goToPrevious: () => void;
  goToNext: () => void;
  setDate: (date: Date) => void;
  selectDateAndSwitchToDaily: (date: Date) => void;

  // View actions
  setCalendarView: (view: CalendarViewType) => void;

  // Filter actions
  setFilter: (filter: FilterState) => void;
  toggleMember: (memberId: string) => void;
  toggleAllMembers: (allMemberIds: string[]) => void;
  toggleAllDayEvents: () => void;
  initializeSelectedMembers: (memberIds: string[]) => void;
  syncMembers: (currentMemberIds: string[]) => void;

  // Modal actions
  openAddEventModal: (defaultValues?: Partial<EventFormData>) => void;
  closeAddEventModal: () => void;

  // Detail modal actions
  openDetailModal: (event: CalendarEvent) => void;
  closeDetailModal: () => void;

  // Edit modal actions
  openEditModal: (event: CalendarEvent) => void;
  closeEditModal: () => void;
}

export const useCalendarStore = create<CalendarState>()(
  persist(
    (set, get) => ({
      // Initial state
      currentDate: new Date(),
      calendarView: "weekly",
      hasUserSetView: false,
      filter: {
        selectedMembers: [], // Will be initialized when family members are loaded
        showAllDayEvents: true,
      },
      knownMemberIds: [],
      isAddEventModalOpen: false,
      dayRailHidden: false,
      addEventDefaults: null,

      // Event detail modal state
      selectedEvent: null,
      isDetailModalOpen: false,

      // Edit modal state
      editingEvent: null,
      isEditModalOpen: false,

      // Navigation actions
      goToToday: () => set({ currentDate: new Date() }),

      goToPrevious: () => {
        const { currentDate, calendarView } = get();
        const newDate = new Date(currentDate);

        switch (calendarView) {
          case "daily":
            newDate.setDate(currentDate.getDate() - 1);
            break;
          case "weekly":
          case "schedule":
            newDate.setDate(currentDate.getDate() - 7);
            break;
          case "monthly": {
            // Handle month navigation with day clamping to avoid overflow
            // (e.g., Mar 31 → Feb 28, not Mar 3)
            const targetMonth = currentDate.getMonth() - 1;
            const targetYear =
              targetMonth < 0
                ? currentDate.getFullYear() - 1
                : currentDate.getFullYear();
            const normalizedMonth = targetMonth < 0 ? 11 : targetMonth;
            // Get last day of target month (day 0 of next month = last day of target month)
            const lastDayOfTargetMonth = new Date(
              targetYear,
              normalizedMonth + 1,
              0,
            ).getDate();
            const clampedDay = Math.min(
              currentDate.getDate(),
              lastDayOfTargetMonth,
            );
            newDate.setFullYear(targetYear, normalizedMonth, clampedDay);
            break;
          }
        }

        set({ currentDate: newDate });
      },

      goToNext: () => {
        const { currentDate, calendarView } = get();
        const newDate = new Date(currentDate);

        switch (calendarView) {
          case "daily":
            newDate.setDate(currentDate.getDate() + 1);
            break;
          case "weekly":
          case "schedule":
            newDate.setDate(currentDate.getDate() + 7);
            break;
          case "monthly": {
            // Handle month navigation with day clamping to avoid overflow
            // (e.g., Jan 31 → Feb 28, not Mar 3)
            const targetMonth = currentDate.getMonth() + 1;
            const targetYear =
              targetMonth > 11
                ? currentDate.getFullYear() + 1
                : currentDate.getFullYear();
            const normalizedMonth = targetMonth > 11 ? 0 : targetMonth;
            // Get last day of target month (day 0 of next month = last day of target month)
            const lastDayOfTargetMonth = new Date(
              targetYear,
              normalizedMonth + 1,
              0,
            ).getDate();
            const clampedDay = Math.min(
              currentDate.getDate(),
              lastDayOfTargetMonth,
            );
            newDate.setFullYear(targetYear, normalizedMonth, clampedDay);
            break;
          }
        }

        set({ currentDate: newDate });
      },

      setDate: (date) => set({ currentDate: date }),

      selectDateAndSwitchToDaily: (date) =>
        set({
          currentDate: date,
          calendarView: "daily",
        }),

      // View actions
      setCalendarView: (view) =>
        set({ calendarView: view, hasUserSetView: true }),

      // Filter actions
      setFilter: (filter) => set({ filter }),

      toggleDayRail: () =>
        set((state) => ({ dayRailHidden: !state.dayRailHidden })),

      toggleMember: (memberId) => {
        const { filter } = get();
        const isSelected = filter.selectedMembers.includes(memberId);
        const newSelectedMembers = isSelected
          ? filter.selectedMembers.filter((id) => id !== memberId)
          : [...filter.selectedMembers, memberId];

        set({ filter: { ...filter, selectedMembers: newSelectedMembers } });
      },

      toggleAllMembers: (allMemberIds) => {
        const { filter } = get();
        const allSelected =
          filter.selectedMembers.length === allMemberIds.length;

        set({
          filter: {
            ...filter,
            selectedMembers: allSelected ? [] : allMemberIds,
          },
        });
      },

      initializeSelectedMembers: (memberIds) => {
        const { filter } = get();
        set({
          filter: { ...filter, selectedMembers: memberIds },
        });
      },

      syncMembers: (currentMemberIds) => {
        if (currentMemberIds.length === 0) return;
        const { filter, knownMemberIds } = get();

        const currentSet = new Set(currentMemberIds);
        const stillValid = filter.selectedMembers.filter((id) =>
          currentSet.has(id),
        );

        // Nothing selected, or every selection points at a removed member.
        if (stillValid.length === 0) {
          set({
            filter: { ...filter, selectedMembers: currentMemberIds },
            knownMemberIds: currentMemberIds,
          });
          return;
        }

        // Members that appeared since the last sync default to visible, so a
        // person added on another device (or by an import script) is not
        // silently filtered out. Anyone already known stays hidden if the user
        // deselected them.
        //
        // With nothing recorded yet (state persisted before this list existed)
        // adopt the current roster as the baseline and change no selection —
        // otherwise an intentional deselection would be undone once.
        const nextSelected =
          knownMemberIds.length === 0
            ? stillValid
            : [
                ...stillValid,
                ...currentMemberIds.filter(
                  (id) => !knownMemberIds.includes(id),
                ),
              ];

        const sameSelection =
          nextSelected.length === filter.selectedMembers.length &&
          nextSelected.every((id, i) => id === filter.selectedMembers[i]);
        const sameKnown =
          currentMemberIds.length === knownMemberIds.length &&
          currentMemberIds.every((id, i) => id === knownMemberIds[i]);
        if (sameSelection && sameKnown) return;

        set({
          ...(sameSelection
            ? {}
            : { filter: { ...filter, selectedMembers: nextSelected } }),
          ...(sameKnown ? {} : { knownMemberIds: currentMemberIds }),
        });
      },

      toggleAllDayEvents: () => {
        const { filter } = get();
        set({
          filter: { ...filter, showAllDayEvents: !filter.showAllDayEvents },
        });
      },

      // Modal actions
      openAddEventModal: (defaultValues) =>
        set({
          isAddEventModalOpen: true,
          addEventDefaults: defaultValues ?? null,
        }),
      closeAddEventModal: () =>
        set({ isAddEventModalOpen: false, addEventDefaults: null }),

      // Detail modal actions
      openDetailModal: (event) =>
        set({ selectedEvent: event, isDetailModalOpen: true }),
      closeDetailModal: () =>
        set({ selectedEvent: null, isDetailModalOpen: false }),

      // Edit modal actions
      openEditModal: (event) =>
        set({
          editingEvent: event,
          isEditModalOpen: true,
          isDetailModalOpen: false, // Close detail when opening edit
        }),
      closeEditModal: () => set({ editingEvent: null, isEditModalOpen: false }),
    }),
    {
      name: "family-hub-calendar",
      // Persist filter and view preferences
      partialize: (state) => ({
        filter: state.filter,
        knownMemberIds: state.knownMemberIds,
        calendarView: state.calendarView,
        hasUserSetView: state.hasUserSetView,
        dayRailHidden: state.dayRailHidden,
      }),
    },
  ),
);

// Selector: hasUserSetView (for smart defaulting)
export const useHasUserSetView = () =>
  useCalendarStore((state) => state.hasUserSetView);

// Computed selector: isViewingToday
export const useIsViewingToday = () =>
  useCalendarStore((state) => {
    const { currentDate, calendarView } = state;
    const today = new Date();

    switch (calendarView) {
      case "daily":
        return currentDate.toDateString() === today.toDateString();
      case "weekly":
      case "schedule": {
        const startOfWeek = new Date(currentDate);
        startOfWeek.setDate(currentDate.getDate() - currentDate.getDay());
        const endOfWeek = new Date(startOfWeek);
        endOfWeek.setDate(startOfWeek.getDate() + 6);
        return today >= startOfWeek && today <= endOfWeek;
      }
      case "monthly":
        return (
          currentDate.getMonth() === today.getMonth() &&
          currentDate.getFullYear() === today.getFullYear()
        );
      default:
        return true;
    }
  });

export const useDayRailState = () =>
  useCalendarStore(
    useShallow((state) => ({
      dayRailHidden: state.dayRailHidden,
      toggleDayRail: state.toggleDayRail,
    })),
  );

/**
 * Compound selector for calendar state.
 * Combines multiple state values into a single subscription with shallow comparison.
 */
export const useCalendarState = () =>
  useCalendarStore(
    useShallow((state) => ({
      currentDate: state.currentDate,
      calendarView: state.calendarView,
      filter: state.filter,
      isAddEventModalOpen: state.isAddEventModalOpen,
      addEventDefaults: state.addEventDefaults,
    })),
  );

/**
 * Compound selector for calendar actions.
 * Combines multiple actions into a single subscription.
 */
export const useCalendarActions = () =>
  useCalendarStore(
    useShallow((state) => ({
      goToToday: state.goToToday,
      goToPrevious: state.goToPrevious,
      goToNext: state.goToNext,
      setDate: state.setDate,
      selectDateAndSwitchToDaily: state.selectDateAndSwitchToDaily,
      setCalendarView: state.setCalendarView,
      openAddEventModal: state.openAddEventModal,
      closeAddEventModal: state.closeAddEventModal,
      openEditModal: state.openEditModal,
      closeEditModal: state.closeEditModal,
    })),
  );

/**
 * Compound selector for event detail modal.
 * Combines detail modal state and actions.
 */
export const useEventDetailState = () =>
  useCalendarStore(
    useShallow((state) => ({
      selectedEvent: state.selectedEvent,
      isDetailModalOpen: state.isDetailModalOpen,
      openDetailModal: state.openDetailModal,
      closeDetailModal: state.closeDetailModal,
    })),
  );

/**
 * Compound selector for edit modal state.
 */
export const useEditModalState = () =>
  useCalendarStore(
    useShallow((state) => ({
      editingEvent: state.editingEvent,
      isEditModalOpen: state.isEditModalOpen,
      openEditModal: state.openEditModal,
      closeEditModal: state.closeEditModal,
    })),
  );

/**
 * Compound selector for filter pills component.
 * Combines filter state and toggle actions.
 */
export const useFilterPillsState = () =>
  useCalendarStore(
    useShallow((state) => ({
      filter: state.filter,
      toggleMember: state.toggleMember,
      toggleAllMembers: state.toggleAllMembers,
      toggleAllDayEvents: state.toggleAllDayEvents,
      initializeSelectedMembers: state.initializeSelectedMembers,
      syncMembers: state.syncMembers,
    })),
  );
