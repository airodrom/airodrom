'use strict';
// Development Sessions panel entry. Governed OpenCode Mission fills the summary.
// Avoid embedding private path roots or auth material literals in this module.
window.AirodromDevelopmentSessions = {
  /**
   * @param {HTMLElement} result
   * @param {object} ds snapshot.development_sessions
   * @param {object} ui { glass, node, button, api, stamp, conversationNotice setter via ui }
   * @returns {boolean} true when this panel fully handled the view
   */
  render(result, ds, ui) {
    // Clear the result container
    result.innerHTML = '';
    
    // 1. Local-first defaults card
    const defaultsCard = ui.glass();
    defaultsCard.appendChild(ui.node('h3', 'Local-first Defaults'));
    const defaultsList = ui.node('ul');
    defaultsList.appendChild(ui.node('li', 'Auto push: off'));
    defaultsList.appendChild(ui.node('li', 'Auto merge: off'));
    defaultsList.appendChild(ui.node('li', 'Hosted CI auto-dispatch: off'));
    defaultsList.appendChild(ui.node('li', `Merge window: ${ds.merge_window_open ? 'open' : 'closed'} (${ds.merge_window})`));
    defaultsCard.appendChild(defaultsList);
    result.appendChild(defaultsCard);
    
    // 2. Prepare Daily Integration button
    const prepareButton = ui.button('Prepare Daily Integration');
    prepareButton.addEventListener('click', async () => {
      try {
        await ui.api('/api/assistant/development-sessions/prepare-daily-integration', {
          confirmed: true,
          request_id: crypto.randomUUID()
        });
        
        // Show notice and refresh when window.__dailyIntegration is set
        if (window.__dailyIntegration) {
          ui.setNotice('Daily integration prepared');
          // In a real implementation, we would redraw here or wait for the update
        }
      } catch (error) {
        ui.setNotice(`Error preparing daily integration: ${error.message}`);
      }
    });
    
    const prepareSection = ui.node('div');
    prepareSection.appendChild(prepareButton);
    if (window.__dailyIntegration) {
      const summary = ui.node('div');
      summary.textContent = `Prepared checkpoint: ${window.__dailyIntegration.summary}`;
      prepareSection.appendChild(summary);
    }
    result.appendChild(prepareSection);
    
    // 3. Active Session Summary glass card
    const activeSessionCard = ui.glass();
    activeSessionCard.appendChild(ui.node('h3', 'Active Development Session'));
    
    const activeSessionList = ui.node('ul');
    
    // Determine the active session object (ds.active or fallback to ds.recent[0])
    const activeSession = ds.active || (ds.recent && ds.recent[0]);
    
    if (activeSession) {
      // Associated Missions
      const missionsItem = ui.node('li', `Associated Missions: ${activeSession.missions?.length || 0}`);
      activeSessionList.appendChild(missionsItem);
      
      // Current worker
      const workerItem = ui.node('li', `Current worker: ${activeSession.worker || 'N/A'}`);
      activeSessionList.appendChild(workerItem);
      
      // Repository and branch
      const repoBranch = `${(activeSession.repo || 'N/A')} (${activeSession.branch || 'N/A'})`;
      const repoBranchItem = ui.node('li', `Repository and branch: ${repoBranch}`);
      activeSessionList.appendChild(repoBranchItem);
      
      // Local changes
      const localChanges = (activeSession.dirty_files && activeSession.dirty_files.length) || 0;
      const changesItem = ui.node('li', `Local changes: ${localChanges}`);
      activeSessionList.appendChild(changesItem);
      
      // Focused verification
      const focusedVerification = ui.node('li', `Focused verification: ${activeSession.focus || 'N/A'}`);
      activeSessionList.appendChild(focusedVerification);
      
      // Pending integration checkpoint
      const pendingCheckpoint = ui.node('li', `Pending integration checkpoint: ${activeSession.checkpoint || 'N/A'}`);
      activeSessionList.appendChild(pendingCheckpoint);
      
      // Last completed activity
      const lastActivity = activeSession.last_activity ? new Date(activeSession.last_activity).toLocaleString() : 'N/A';
      const activityItem = ui.node('li', `Last completed activity: ${lastActivity}`);
      activeSessionList.appendChild(activityItem);
      
      // Next permitted action
      let nextAction = '';
      switch (activeSession.integration_state) {
        case 'LOCAL_ONLY':
          nextAction = 'Continue local work / record focused evidence';
          break;
        case 'READY_TO_PUSH':
          nextAction = 'Operator push authorization required';
          break;
        case 'PR_OPEN':
          nextAction = 'Await CI or operator';
          break;
        case 'READY_TO_MERGE':
          nextAction = 'Operator merge authorization required';
          break;
        case 'MERGED':
          nextAction = 'Session closed';
          break;
        default:
          nextAction = 'Review session evidence';
      }
      const actionItem = ui.node('li', `Next permitted action: ${nextAction}`);
      activeSessionList.appendChild(actionItem);
    } else {
      // Empty state when no active session
      const emptyItem = ui.node('li', 'No active session');
      activeSessionList.appendChild(emptyItem);
    }
    
    activeSessionCard.appendChild(activeSessionList);
    result.appendChild(activeSessionCard);
    
    // 4. Recent sessions list
    if (ds.recent && ds.recent.length > 0) {
      const recentCard = ui.glass();
      recentCard.appendChild(ui.node('h3', 'Recent Sessions'));
      
      const recentList = ui.node('ul');
      
      ds.recent.forEach(session => {
        const sessionItem = ui.node('li');
        const sessionContent = ui.node('div');
        
        // Goal
        const goal = ui.node('strong', `Goal: ${session.goal || 'N/A'}`);
        sessionContent.appendChild(goal);
        
        // Integration state
        const state = ui.node('span', `State: ${session.integration_state || 'N/A'}`);
        sessionContent.appendChild(ui.node('div', state));
        
        // Worker
        const worker = ui.node('span', `Worker: ${session.worker || 'N/A'}`);
        sessionContent.appendChild(ui.node('div', worker));
        
        // Branch
        const branch = ui.node('span', `Branch: ${session.branch || 'N/A'}`);
        sessionContent.appendChild(ui.node('div', branch));
        
        // Mission count
        const missionCount = ui.node('span', `Missions: ${session.missions?.length || 0}`);
        sessionContent.appendChild(ui.node('div', missionCount));
        
        // Dirty files
        const dirtyCount = (session.dirty_files && session.dirty_files.length) || 0;
        const dirtyFiles = ui.node('span', `Dirty files: ${dirtyCount}`);
        sessionContent.appendChild(ui.node('div', dirtyFiles));
        
        // Evidence status
        let evidenceStatus = 'N/A';
        if (session.evidence) {
          const passed = session.evidence.passed?.length || 0;
          const failed = session.evidence.failed?.length || 0;
          evidenceStatus = `${passed} passed, ${failed} failed`;
        }
        const evidence = ui.node('span', `Evidence: ${evidenceStatus}`);
        sessionContent.appendChild(ui.node('div', evidence));
        
        // Head SHA short
        const headSha = session.head_sha ? session.head_sha.substring(0, 7) : 'N/A';
        const sha = ui.node('span', `Head: ${headSha}`);
        sessionContent.appendChild(ui.node('div', sha));
        
        sessionItem.appendChild(sessionContent);
        recentList.appendChild(sessionItem);
      });
      
      recentCard.appendChild(recentList);
      result.appendChild(recentCard);
    }
    
    // 5. Closing note
    const closingNote = ui.glass();
    closingNote.appendChild(ui.node('p', 'Acceptance remains Mission host verification and sessions never grant Acceptance or auto-merge.'));
    result.appendChild(closingNote);
    
    return true;
  }
};
