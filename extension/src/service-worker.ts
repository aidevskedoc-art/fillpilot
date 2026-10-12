// The toolbar button opens the side panel; everything else happens in the panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => console.error(err));
