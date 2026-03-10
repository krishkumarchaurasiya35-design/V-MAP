console.log("--- script.js successfully loaded ---\n\n--- supabase Configuration Loaded ---\n--- Custom Receipt, Debt Logic, and Payment Mode Integrated ---");

/* -------------------------------------------------------------------
 * File: script.js
 * Description: All core JavaScript logic for the Railway Ticket Violation System.
 * Handles Auth, Role-based routing, Data fetching, Fine Calculation, and UI logic for all pages.
 * NOTE: ALL HARDCODED DATA REMOVED. REQUIRES BACKEND (SUPABASE) SETUP.
 * ------------------------------------------------------------------- */

// --- 1. CONFIGURATION AND INITIALIZATION ---

const supabaseUrl = "https://qinachiytzqbzuiqnjjz.supabase.co";
const supabaseKey = "sb_publishable_UBQWTPrHSfeNaLEQdpjk1g_h-wdDpFq";

const Supabase = window.supabase.createClient(supabaseUrl, supabaseKey);

// Global state for pagination/sorting on all_violations.html (unused on dashboard)
let currentPage = 1;
const pageSize = 10;
let sortColumn = 'created_at';
let sortDirection = 'desc';

// Flags to prevent duplicate form listeners after dashboard refresh (efficiency fix)
let hasStaffFormListener = false;
let hasRuleFormListener = false;
let hasTTEFormListener = false;

// Global Role State 
let userRole = null; // 'super_admin', 'station_manager', 'tc', or null for public/unauthenticated
let userName = 'User'; // Global user name for welcome messages
let currentUserId = null; // Global user ID

// Roles used for the dropdown (role_id: name)
const STAFF_ROLES = {
    2: 'Station Manager',
    3: 'TTE (Ticket Checker)'
};

// --- GLOBAL STATE FOR VIOLATION IN PROGRESS ---
let currentViolationData = {}; 
let lastGeneratedReceipt = null; // Stores the finalized receipt data after payment

// --- 2. GLOBAL UTILITIES ---

function showToast(message, isError = false) {
    const container = document.getElementById('toast-container') || (() => {
        const div = document.createElement('div');
        div.id = 'toast-container';
        // Add minimal styling for toasts (assuming basic CSS exists)
        div.style.position = 'fixed';
        div.style.top = '20px';
        div.style.right = '20px';
        div.style.zIndex = '2000'; // Increased Z-index
        document.body.appendChild(div);
        return div;
    })();

    const toast = document.createElement('div');
    toast.className = `toast ${isError ? 'error' : 'success'}`; // Use CSS classes
    toast.textContent = message;
    
    // Add minimal inline styling if CSS file is missing
    if (document.querySelector('link[rel="stylesheet"]').disabled) {
        toast.style.padding = '10px 15px';
        toast.style.borderRadius = '8px';
        toast.style.marginBottom = '10px';
        toast.style.backgroundColor = isError ? '#ef4444' : '#10b981';
        toast.style.color = 'white';
        toast.style.borderLeft = isError ? '5px solid #b91c1c' : '5px solid #047857';
    }


    container.appendChild(toast);

    // Apply the 'show' class to trigger CSS transition
    setTimeout(() => { 
        toast.classList.add('show');
    }, 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 500);
    }, 4000);
}

/**
 * Unlocks Name and Mobile fields for editing
 */
function enablePassengerEditing() {
    document.getElementById('passenger-name').readOnly = false;
    document.getElementById('passenger-mobile').readOnly = false;
    document.getElementById('passenger-name').focus();
    showToast('Editing enabled.', false);
}

function debounce(func, delay) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), delay);
    };
}

function formatDate(timestamp) {
    if (!timestamp) return 'N/A';
    const date = new Date(timestamp);
    const options = {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
    };
    return date.toLocaleString(undefined, options);
}

function formatCurrency(amount) {
    if (typeof amount !== 'number' || isNaN(amount)) return '₹0';
    // Use Indian locale for formatting
    return `₹${amount.toLocaleString('en-IN')}`;
}

function generateReceiptUID() {
    // Violation Reference Number (RRT + Timestamp + Random)
    return 'RRT' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
}

/**
 * NEW: Generates a unique Grievance Reference Number
 */
function generateGrievanceUID() {
    // Grievance Reference Number (GRV + Timestamp + Random)
    return 'GRV' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
}

function generateTransactionUID() {
    // Unique Transaction ID (TXN + Timestamp + Random)
    return 'TXN' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
}

/**
 * LOGGING: Records sensitive actions performed by the Super Admin.
 * NOTE: Requires a 'superadmin_logs' table in your Supabase backend (not defined here).
 */
async function logActivity(action, details) {
    const { data: { session } } = await Supabase.auth.getSession();
    const userId = session?.user?.id || 'SYSTEM';
    const userName = session?.user?.email || 'Super Admin';

    const logRecord = {
        user_id: userId,
        user_email: userName,
        action: action,
        details: JSON.stringify(details), 
        timestamp: new Date().toISOString()
    };

    // NOTE: If the 'superadmin_logs' table is not created in Supabase, this will fail silently.
    const { error } = await Supabase
        .from('superadmin_logs') 
        .insert([logRecord]);

    if (error) {
        console.error("Failed to log activity:", error);
    }
}


// --- 3. AUTHENTICATION & ROLE MANAGEMENT ---

async function getUserRoleAndProfile(userId) {
    if (!userId) return { role: null, name: null };

    const { data, error } = await Supabase
        .from('profiles')
        .select('roles(name), full_name')
        .eq('id', userId)
        .single();

    if (error || !data || !data.roles) {
        console.error("Error fetching user role or profile missing:", error || "Data missing.");
        return { role: null, name: null };
    }
    return { role: data.roles.name, name: data.full_name || data.email };
}

// Function to update the welcome message on pages with the correct element ID
function updateWelcomeMessage(name) {
    const welcomeEl = document.getElementById('welcome-message');
    if (welcomeEl) {
        welcomeEl.textContent = `Welcome, ${name}!`;
    }
}

// Adjusted to handle navigation based on role
async function handleRoleNavigation(role) {
    const currentPageName = window.location.pathname.split('/').pop();

    // Pages all authenticated staff can access without strict redirection checks
    const staffAllowedPages = ['index.html', 'tte_dashboard.html', 'add_violation.html', 'payment.html', 'passenger_payment_portal.html', 'receipt.html'];

    // Super Admin should go to superadmin_dashboard.html
    if (role === 'super_admin' && currentPageName !== 'superadmin_dashboard.html' && !staffAllowedPages.includes(currentPageName)) {
         showToast('Access Denied: Redirecting to Super Admin Dashboard.', true);
         window.location.href = 'superadmin_dashboard.html';
         return;
    }
    // Station Manager should go to admin_dashboard.html
    if (role === 'station_manager' && currentPageName !== 'admin_dashboard.html' && !staffAllowedPages.includes(currentPageName)) {
         showToast('Access Denied: Redirecting to Station Manager Dashboard.', true);
         window.location.href = 'admin_dashboard.html';
         return;
    }
    // TTE should go to tte_dashboard.html or allowed operational pages
    if (role === 'tc' && !staffAllowedPages.includes(currentPageName) && currentPageName !== 'helpdesk.html') {
         showToast('Access Denied: Redirecting to TTE Dashboard.', true);
         window.location.href = 'tte_dashboard.html';
         return;
    }
    
    // Hide unnecessary links based on page
    const linksToHide = [];
    if (currentPageName === 'tte_dashboard.html' || currentPageName === 'add_violation.html') {
        // TTE Dashboard should only show links relevant to TTEs
        linksToHide.push('nav-rules', 'nav-manage-users', 'nav-analytics', 'nav-manage-ttes');
    }
    if (currentPageName === 'admin_dashboard.html') {
        // Admin Dashboard hides Super Admin links
        linksToHide.push('nav-rules', 'nav-manage-users');
    }

    linksToHide.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
}

/**
 * Super Admin function to create user (Manager/TTE) and assign role/station
 * MODIFIED: Now handles higher_officer_id assignment based on role and current user.
 */
async function createStaffUser(email, password, roleId, employeeId, fullName, age, mobileNumber, stationName = null) {
    
    if (!email || !password || !roleId || !employeeId || !fullName || !age || !mobileNumber) {
        return { error: { message: "All user fields are required." } };
    }
    
    // Check if stationName is required for Station Manager (Role ID 2)
    if (roleId === 2 && !stationName) {
        return { error: { message: "Station Name is required for Station Managers." } };
    }

    let newUserId = null;
    let higherOfficerId = null;
    const { data: { session } } = await Supabase.auth.getSession();
    const currentUserId = session?.user?.id;
    
    // Determine the higher officer ID based on the role being created
    if (roleId === 2) { // Station Manager being created by Super Admin
        higherOfficerId = currentUserId; // Super Admin is the higher officer
    } else if (roleId === 3 && userRole === 'station_manager') { // TTE being created by Station Manager
        higherOfficerId = currentUserId; // Station Manager is the higher officer
    } else if (roleId === 3 && userRole === 'super_admin') {
         // If Super Admin creates a TTE directly, we can skip assigning a manager
         higherOfficerId = currentUserId;
         console.warn("Super Admin created TTE directly. Higher officer set to Super Admin.");
    }
    
    try {
        // 1. Supabase Auth Sign Up
        const { data: userData, error: authError } = await Supabase.auth.signUp({
            email: email,
            password: password,
            options: {
                data: { role_id: roleId }
            }
        });

        if (authError) {
            console.error("Staff creation failed (Auth):", authError);
            throw new Error(authError.message);
        }

        newUserId = userData.user.id;

        // 2. UPDATE Profile Data (Database trigger creates the profile, we update it immediately)
        const profileData = {
            email: email, 
            role_id: roleId, 
            employee_id: employeeId,
            full_name: fullName,
            age: age,
            mobile_number: mobileNumber,
            station_name: stationName,
            // NEW: Assign the higher officer ID
            higher_officer_id: higherOfficerId 
        };

        const { error: profileError } = await Supabase
            .from('profiles')
            .update(profileData)
            .eq('id', newUserId) 
            .select();

        if (profileError) {
            console.error("Profile update failed:", profileError);
            throw new Error(`Profile data save failed: ${profileError.message}. The user account was created but may be missing detailed profile data.`);
        }
        
        // 3. Auto-assign TTEs to the current Manager if Manager is creating staff (Role 3)
        if (roleId === 3 && userRole === 'station_manager') {
             const { error: assignmentError } = await Supabase
                .from('ttes')
                .insert([{ id: newUserId, manager_id: higherOfficerId }]) // Use higherOfficerId (current user)
                .select();
            
             if (assignmentError) {
                 console.error("TTE assignment failed:", assignmentError);
                 throw new Error(`TTE assignment failed: ${assignmentError.message}`);
             }
        }
        
        // 4. LOG ACTIVITY
        await logActivity('CREATE_STAFF_PROFILE', { new_user_id: newUserId, role: STAFF_ROLES[roleId], station: stationName, higher_officer: higherOfficerId });

        return { data: userData.user, error: null };

    } catch (e) {
        console.error('Staff creation error:', e);
        return { error: { message: e.message } };
    }
}

/**
 * Super Admin function to delete staff (Manager or TTE).
 * FIX: Replaced window.prompt with direct action execution. UI button must be the confirmation.
 */
async function deleteStaffUser(userId, roleName) {
    if (userRole !== 'super_admin') {
        showToast('Permission Denied: Only Super Admin can delete staff.', true);
        return;
    }
    
    // FIX: Removed window.prompt. The button click is now the confirmation.
    showToast(`Attempting permanent deletion of ${roleName} profile (ID: ${userId}).`, true);

    try {
        // 1. If deleting a Station Manager, first ensure their TTE assignments are cleared.
        if (roleName === 'Station Manager') {
             const { error: tteDeleteError } = await Supabase
                .from('ttes')
                .delete()
                .eq('manager_id', userId);
            
             if (tteDeleteError) {
                 console.warn("Failed to clear TTE assignments for manager:", tteDeleteError);
                 showToast(`Warning: Could not clear TTE assignments for Manager, but attempting profile delete. RLS issue?`, true);
             }
        }

        // 2. Delete the profile entry. This strips the user of their role.
        const { error: profileError } = await Supabase
            .from('profiles')
            .delete()
            .eq('id', userId);

        if (profileError) throw profileError;
        
        // 3. LOG ACTIVITY
        await logActivity('DELETE_STAFF_PROFILE', { target_user_id: userId, target_role: roleName });


        showToast(`${roleName} profile deleted successfully! Access revoked.`, false);
        loadStaffManagementSection(); // Refresh the list

    } catch (e) {
        console.error('Staff deletion error:', e);
        showToast(`Failed to delete profile: ${e.message}`, true);
    }
}

/**
 * Super Admin function to delete a violation record.
 * FIX: Replaced window.prompt with direct action execution. UI button must be the confirmation.
 */
async function deleteViolation(violationId, receiptId) {
    if (userRole !== 'super_admin') {
        showToast('Permission Denied: Only Super Admin can delete violations.', true);
        return;
    }

    // FIX: Removed window.prompt. The button click is now the confirmation.
    showToast(`Attempting permanent deletion of violation ${receiptId}.`, true);

    try {
        const { error } = await Supabase
            .from('violations')
            .delete()
            .eq('id', violationId);

        if (error) throw error;
        
        // LOG ACTIVITY
        await logActivity('DELETE_VIOLATION', { violation_id: violationId, receipt_uid: receiptId });

        showToast(`Violation ${receiptId} deleted successfully.`, false);
        // Using `searchSuperAdminViolations` with current settings to refresh the visible list
        searchSuperAdminViolations(
            document.getElementById('admin-search-term')?.value.trim() || '',
            document.getElementById('admin-search-status')?.value || 'all'
        ); 
        
    } catch (e) {
        console.error('Violation deletion error:', e);
        showToast(`Failed to delete violation: ${e.message}`, true);
    }
}


// --- RULE MANAGEMENT REFACTOR START ---

/**
 * Super Admin function to update a rule's base fine.
 * NOTE: This function now expects the newFine value to be passed from a modal form.
 */
async function finalizeRuleFineUpdate(ruleId, ruleName, newFine) {
    if (userRole !== 'super_admin') {
        showToast('Permission Denied: Only Super Admin can edit rules.', true);
        return;
    }
     const fineAmount = parseFloat(newFine);
     if (isNaN(fineAmount) || fineAmount < 10) { // Enforce a minimum fine
        showToast('Invalid fine amount entered. Must be a number greater than or equal to ₹10.', true);
        return;
    }

    try {
        const { error } = await Supabase
            .from('rules')
            .update({ base_fine: fineAmount, last_updated: new Date().toISOString() })
            .eq('id', ruleId);

        if (error) throw error;
        
        // LOG ACTIVITY
        await logActivity('UPDATE_RULE_FINE', { rule_id: ruleId, rule_name: ruleName, new_fine: fineAmount });


        showToast(`Rule fine for "${ruleName}" updated successfully!`, false);
        loadRulesManagementSection();
    } catch (e) {
        console.error("Error updating rule fine:", e);
        showToast(`Failed to update rule fine: ${e.message}`, true);
    }
}

/**
 * FIX: Fully implemented function to open the rule update modal.
 */
window.openRuleFineEditModal = (ruleId, ruleName, currentFine) => {
    const modal = document.getElementById('rule-update-modal');
    if (!modal) {
        console.error("Rule update modal not found.");
        showToast("Rule Update Modal is missing from the HTML.", true);
        return;
    }
    
    // Set data in the modal form
    document.getElementById('update-rule-id').value = ruleId;
    document.getElementById('update-rule-name-display').textContent = ruleName;
    document.getElementById('update-new-fine').value = currentFine;
    
    modal.style.display = 'block';
};


/**
 * Super Admin function to delete a rule.
 * FIX: Replaced window.prompt with direct action execution. UI button must be the confirmation.
 */
async function deleteRule(ruleId, ruleName) {
    if (userRole !== 'super_admin') {
        showToast('Permission Denied: Only Super Admin can delete rules.', true);
        return;
    }
    
    // FIX: Removed window.prompt. The button click is now the confirmation.
    showToast(`Attempting permanent deletion of rule: ${ruleName}.`, true);

    try {
        const { error } = await Supabase
            .from('rules')
            .delete()
            .eq('id', ruleId);

        if (error) throw error;
        
        // LOG ACTIVITY
        await logActivity('DELETE_RULE', { rule_id: ruleId, rule_name: ruleName });


        showToast(`Rule "${ruleName}" deleted successfully.`, false);
        loadRulesManagementSection();
    } catch (e) {
        console.error("Error deleting rule:", e);
        showToast(`Failed to delete rule: ${e.message}`, true);
    }
}
// --- RULE MANAGEMENT REFACTOR END ---

// Placeholder for Super Admin editing a violation (requires a modal/form implementation)
window.openViolationEditModal = (violationData) => {
    // In a full implementation, this would populate a form with violationData 
    // and submit changes back to Supabase.
    showToast(`Editing Violation ${violationData.receipt_uid} (ID: ${violationData.id}). Feature implementation pending.`, false);
    console.log("Attempting to edit violation:", violationData);
};

// --- STAFF PROFILE UPDATE LOGIC (Used by Super Admin) ---
window.openSuperAdminStaffEditModal = (staffData) => {
    const modal = document.getElementById('staff-update-modal');
    if (!modal) {
        console.error("Staff update modal not found.");
        return;
    }

    // Set data in the modal form
    document.getElementById('update-staff-id').value = staffData.id;
    document.getElementById('update-staff-name').value = staffData.full_name;
    document.getElementById('update-staff-age').value = staffData.age || '';
    document.getElementById('update-staff-mobile').value = staffData.mobile_number || '';
    document.getElementById('update-staff-employee-id').value = staffData.employee_id;
    
    const stationInput = document.getElementById('update-staff-station-name');
    stationInput.value = staffData.station_name || '';

    // Only allow editing station name for Station Managers (role_id 2)
    const isManager = staffData.role === 'Station Manager'; // Corrected role string matching
    stationInput.disabled = !isManager;
    stationInput.required = isManager;
    stationInput.placeholder = isManager ? 'Station Name (Required)' : 'N/A (TTE)';
    
    modal.style.display = 'block';
};

async function updateStaffProfile(e) {
    e.preventDefault();
    
    const modal = document.getElementById('staff-update-modal');
    
    const userId = document.getElementById('update-staff-id').value;
    const fullName = document.getElementById('update-staff-name').value.trim();
    const age = parseInt(document.getElementById('update-staff-age').value);
    const mobileNumber = document.getElementById('update-staff-mobile').value.trim();
    const employeeId = document.getElementById('update-staff-employee-id').value.trim();
    const stationNameInput = document.getElementById('update-staff-station-name');
    const stationName = stationNameInput.value.trim() || null;
    
    if (isNaN(age) || mobileNumber.length < 10) {
        showToast('Please check Age (must be a number) and Mobile Number.', true);
        return;
    }

    try {
        const updatePayload = {
            full_name: fullName,
            age: age,
            mobile_number: mobileNumber,
            employee_id: employeeId
        };
        
        // Conditionally include station name only if the field is not disabled (i.e., Manager)
        if (stationNameInput.disabled === false) {
             if (!stationName) throw new Error("Station Name is required for Station Managers.");
             updatePayload.station_name = stationName;
        }


        const { error } = await Supabase
            .from('profiles')
            .update(updatePayload)
            .eq('id', userId);

        if (error) throw error;
        
        // LOG ACTIVITY
        await logActivity('UPDATE_STAFF_PROFILE', { target_user_id: userId, full_name: fullName, updated_fields: Object.keys(updatePayload) });

        showToast(`Profile for ${fullName} updated successfully!`, false);
        modal.style.display = 'none';
        loadStaffManagementSection(); 
    } catch (e) {
        console.error("Profile update failed:", e);
        showToast(`Failed to update profile: ${e.message}`, true);
    }
}
// --- END STAFF PROFILE UPDATE LOGIC ---


async function loginUser() {
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;

    if (!email || !password) {
        showToast('Please enter both email and password.', true);
        return;
    }

    try {
        const { data, error } = await Supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        
        // Fetch full role and name after successful login
        const { role, name } = await getUserRoleAndProfile(data.user.id);

        if (!role) {
             showToast('Login successful but role profile is missing. Contact system administrator.', true);
             await Supabase.auth.signOut();
             return;
        }

        userRole = role;
        userName = name; // Set global state
        currentUserId = data.user.id; // Set global state
        
        updateWelcomeMessage(name); // Immediate update on redirect page (if applicable)

        showToast(`Login successful as ${role}. Redirecting to dashboard...`, false);
        setTimeout(() => {
            if (role === 'super_admin') {
                 window.location.href = 'superadmin_dashboard.html';
            } else if (role === 'station_manager') {
                 window.location.href = 'admin_dashboard.html';
            } else { // 'tc' (TTE)
                 window.location.href = 'tte_dashboard.html';
            }
        }, 500);
    } catch (e) {
        console.error('Login error:', e);
        showToast(`Login failed: ${e.message}`, true);
    }
}

async function logout() {
    try {
        const { error } = await Supabase.auth.signOut();
        if (error) throw error;
        userRole = null;
        userName = 'User';
        currentUserId = null;
        window.location.href = 'index.html';
    } catch (e) {
        console.error('Logout failed:', e);
        showToast('Logout failed. Please try again.', true);
    }
}

async function protectPage() {
    const { data: { session }, error } = await Supabase.auth.getSession();
    const currentPageName = window.location.pathname.split('/').pop();

    // Pages accessible to the public (non-authenticated)
    const publicPages = ['index.html', 'pay_fine.html', 'helpdesk.html', 'passenger_payment_portal.html', 'receipt.html']; 
    if (publicPages.includes(currentPageName)) {
        // Allow public pages to load without authentication check
        if (session) {
            const { role, name } = await getUserRoleAndProfile(session.user.id);
            userRole = role;
            userName = name;
            currentUserId = session.user.id;
            updateWelcomeMessage(name);
        }
        return true;
    }

    // Require authentication for all other pages
    if (error || !session) {
        console.warn("User not authenticated. Redirecting to login.");
        window.location.href = 'index.html';
        return false;
    }

    const { role, name } = await getUserRoleAndProfile(session.user.id);

    if (!role) {
         console.warn("Profile not found for authenticated user. Redirecting to login.");
         await Supabase.auth.signOut();
         window.location.href = 'index.html';
         return false;
    }

    userRole = role;
    userName = name; // Set global state
    currentUserId = session.user.id; // Set global state
    updateWelcomeMessage(name);
    
    handleRoleNavigation(role);

    return true;
}

// --- 4. ADVANCED FINE CALCULATION LOGIC (OPTIMIZED) ---

async function getRuleDetails(ruleId) {
    if (!ruleId) return { baseFine: 0, name: 'N/A' };
    const { data, error } = await Supabase
        .from('rules')
        .select('base_fine, name')
        .eq('id', ruleId)
        .single();

    if (error || !data || data.base_fine === null) {
        console.error("Error fetching rule details or base_fine is null:", error || "Rule data missing.");
        // FIX: Replaced hardcoded default fine with 0 and log an error
        return { baseFine: 0, name: 'Unknown Rule (Error)' };
    }
    return { baseFine: data.base_fine || 0, name: data.name };
}

async function getPassengerFineData(aadhaar, ruleId) {
    if (!aadhaar || !ruleId) {
        return { progressiveCount: 0, totalOutstanding: 0 };
    }
    const { data: passengerData, error: pError } = await Supabase
        .from('passengers')
        .select('id, aadhaar_number') // Fetch aadhaar_number here too
        .eq('aadhaar_number', aadhaar)
        .single();

    if (pError || !passengerData) {
        // Passenger not found, this is the first violation
        return { progressiveCount: 0, totalOutstanding: 0, passengerId: null }; 
    }
    const passengerId = passengerData.id;
    const { data: violations, error: vError } = await Supabase
        .from('violations')
        .select('fine_amount, rule_id, status')
        .eq('passenger_id', passengerId);

    if (vError) {
        console.error("Error fetching passenger violation history:", vError);
        return { progressiveCount: 0, totalOutstanding: 0, passengerId: passengerId };
    }

    let progressiveCount = 0;
    let totalOutstanding = 0;
    violations.forEach(v => {
        // Count previous violations of THIS rule
        if (String(v.rule_id) === String(ruleId)) {
            progressiveCount++;
        }
        // Sum outstanding unpaid fines (regardless of rule)
        if (v.status === 'unpaid') {
            totalOutstanding += v.fine_amount;
        }
    });

    // progressiveCount is the number of PREVIOUS violations. We add 1 for the current one in calculation.
    return {
        progressiveCount: progressiveCount,
        totalOutstanding: totalOutstanding, // Total outstanding debt (not added to current fine)
        passengerId: passengerId,
        aadhaar: passengerData.aadhaar_number // Ensure aadhaar is returned
    };
}

/**
 * Fetches existing passenger data and manages field states.
 */
async function fetchPassengerByAadhaar() {
    const aadhaar = document.getElementById('passenger-aadhaar').value.trim();
    const nameInput = document.getElementById('passenger-name');
    const mobileInput = document.getElementById('passenger-mobile');
    const editBtn = document.getElementById('enable-edit-btn');

    if (aadhaar.length !== 12) {
        showToast('Please enter a valid 12-digit Aadhaar number.', true);
        return;
    }

    try {
        showToast('Searching records...', false);
        const { data, error } = await Supabase
            .from('passengers')
            .select('name, mobile')
            .eq('aadhaar_number', aadhaar)
            .maybeSingle();

        if (error) throw error;

        if (data) {
            // Passenger Found: Fill, Lock, and show Update button
            nameInput.value = data.name || '';
            mobileInput.value = data.mobile || '';
            nameInput.readOnly = true;
            mobileInput.readOnly = true;
            if (editBtn) passengerEditBtn.style.display = 'inline-block';
            showToast('Passenger record found. Fields locked.', false);
        } else {
            // Passenger Not Found: Clear and ensure fields are editable
            nameInput.value = '';
            mobileInput.value = '';
            nameInput.readOnly = false;
            mobileInput.readOnly = false;
            if (editBtn) passengerEditBtn.style.display = 'none';
            showToast('No record found. Please enter details manually.', false);
        }
    } catch (e) {
        showToast(`Fetch failed: ${e.message}`, true);
    }
}

/**
 * Unlocks fields for editing when the Update button is clicked.
 */
function enablePassengerEditing() {
    document.getElementById('passenger-name').readOnly = false;
    document.getElementById('passenger-mobile').readOnly = false;
    document.getElementById('passenger-name').focus();
    showToast('Editing enabled.', false);
}

/**
 * Fetches passenger and manages field locking
 */
async function fetchPassengerByAadhaar() {
    const aadhaar = document.getElementById('passenger-aadhaar').value.trim();
    const nameInput = document.getElementById('passenger-name');
    const mobileInput = document.getElementById('passenger-mobile');
    const passengerEditBtn = document.getElementById('enable-edit-btn');
    if (aadhaar.length !== 12) {
        showToast('Please enter a valid 12-digit Aadhaar number.', true);
        return;
    }

    try {
        const { data, error } = await Supabase
            .from('passengers')
            .select('name, mobile')
            .eq('aadhaar_number', aadhaar)
            .maybeSingle();

        if (data) {
            // Passenger Found: Auto-fill and Lock fields
            nameInput.value = data.name || '';
            mobileInput.value = data.mobile || '';
            nameInput.readOnly = true;
            mobileInput.readOnly = true;
            if (passengerEditBtn) passengerEditBtn.style.display = 'inline-block';            
            showToast('Passenger found. Fields locked. Click "Update" to edit.', false);
        } else {
            // Not Found: Clear and Unlock for manual entry
            nameInput.value = '';
            mobileInput.value = '';
            nameInput.readOnly = false;
            mobileInput.readOnly = false;
            if (passengerEditBtn) passengerEditBtn.style.display = 'none';
            showToast('No record found. Please enter details manually.', false);
        }
    } catch (e) {
        showToast(`Fetch failed: ${e.message}`, true);
    }
}

// --- 5. VIOLATION AND PASSENGER MANAGEMENT LOGIC (TC/TTE) ---

// Helper function to get or create passenger during violation logging

async function getOrCreatePassenger(passengerData) {
    const { name, mobile, aadhaar, dob, address } = passengerData;
    let { data: passengers, error: fetchError } = await Supabase
        .from('passengers')
        .select('id')
        .eq('aadhaar_number', aadhaar)
        .limit(1);
    if (fetchError) throw fetchError;
    
    let passengerId = null;
    if (passengers && passengers.length > 0) {
        passengerId = passengers[0].id;
        
        // NEW LOGIC: Update existing passenger details in case the TTE changed them
        const { error: updateError } = await Supabase
            .from('passengers')
            .update({ 
                name: name, 
                mobile: mobile,
                last_updated: new Date().toISOString() 
            })
            .eq('id', passengerId);
            
        if (updateError) console.error("Minor error updating existing passenger:", updateError);

    } else {
        // Create new passenger if they don't exist
        const newPassenger = { 
            name, 
            mobile, 
            aadhaar_number: aadhaar, 
            date_of_birth: dob || null, 
            address: address || null, 
            last_updated: new Date().toISOString() 
        };
        const { data: createdData, error: createError } = await Supabase
            .from('passengers')
            .insert([newPassenger])
            .select('id')
            .single();
        if (createError) throw createError;
        passengerId = createdData.id;
    }
    return passengerId;
}

async function updatePassengerDetails(passengerId, name, mobile, address, dob) {
    try {
        const { error } = await Supabase
            .from('passengers')
            .update({
                name,
                mobile,
                address,
                date_of_birth: dob || null,
                last_updated: new Date().toISOString()
            })
            .eq('id', passengerId);

        if (error) throw error;
        showToast('Passenger details updated successfully!', false);
    } catch (e) {
        console.error("Error updating passenger details:", e);
        showToast(`Failed to update passenger: ${e.message}`, true);
    }
}

/**
 * The single function to record the violation into the database.
 * @param {string} paymentStatus - 'paid' or 'unpaid'
 * @param {string | null} transactionUID - Unique ID if paid, null if unpaid.
 * @param {string} paymentMode - 'CASH', 'UPI', 'ONLINE_PUBLIC' or 'N/A'
 */
async function addViolation(paymentStatus, transactionUID = null, paymentMode = 'N/A') {
    const data = currentViolationData;
    // The finalBilledAmount in currentViolationData now only holds the CURRENT progressive fine.
    const finalBilledAmount = data.progressiveFine; 
    const passengerName = data.name;

    if (!data || !finalBilledAmount || isNaN(finalBilledAmount) || !data.aadhaar) {
        showToast('System error: Violation data incomplete or missing. Please recalculate the fine.', true);
        return;
    }

    try {
        const { data: { session } } = await Supabase.auth.getSession();
        const tcId = session?.user?.id;
        if (!tcId) throw new Error("TC user not logged in.");

        const passengerId = await getOrCreatePassenger({ 
            name: data.name, 
            mobile: data.mobile, 
            aadhaar: data.aadhaar, 
            dob: data.dob, 
            address: data.address 
        });

        const receiptUID = generateReceiptUID();

        const violationRecord = {
            passenger_id: passengerId,
            rule_id: data.ruleId,
            fine_amount: finalBilledAmount, 
            status: paymentStatus, 
            receipt_uid: receiptUID,
            transaction_uid: transactionUID, // Only generated if paid and needed
            payment_mode: paymentMode, // New: CASH, UPI, ONLINE_PUBLIC, or 'N/A'
            tc_id: tcId,
            location: data.location,
            remarks: data.remarks || null
        };

        const { data: createdViolation, error: violationError } = await Supabase
            .from('violations')
            .insert([violationRecord])
            .select('*')
            .single();

        if (violationError) throw violationError;
        
        // Store finalized receipt data globally
        lastGeneratedReceipt = {
            ...data, 
            id: createdViolation.id,
            receiptUID: createdViolation.receipt_uid,
            transactionUID: createdViolation.transaction_uid,
            status: createdViolation.status,
            fineAmount: createdViolation.fine_amount,
            paymentMode: createdViolation.payment_mode,
            tcId: tcId,
        };

        // Clear global state
        currentViolationData = {};

        showToast(`Violation recorded successfully! Passenger: ${passengerName}. Receipt ID: ${receiptUID}. Status: ${paymentStatus.toUpperCase()}.`, false);
        
        // Return success for next step (receipt generation)
        return true;

    } catch (e) {
        console.error("Error recording violation:", e);
        showToast(`Failed to record violation: ${e.message}`, true);
        return false;
    }
}


/**
 * Handles the click of the "Calculate Fine & Check History" button.
 */
async function calculateFineAndHistory() {
    // 1. Get form data
    const name = document.getElementById('passenger-name').value.trim();
    const mobile = document.getElementById('passenger-mobile').value.trim();
    const aadhaar = document.getElementById('passenger-aadhaar').value.trim();
    const dob = document.getElementById('passenger-dob').value.trim();
    const address = document.getElementById('passenger-address').value.trim();
    const location = document.getElementById('violation-location').value.trim();
    const ruleInput = document.getElementById('violation-type');
    const ruleId = ruleInput.value;
    const remarks = document.getElementById('remarks').value.trim();
    
    const ruleOption = ruleInput.options[ruleInput.selectedIndex];
    const baseFine = parseInt(ruleOption?.dataset?.baseFine || 0);

    const fineDisplayArea = document.getElementById('fine-display-area');
    const finalFineAmountH1 = document.getElementById('final-fine-amount');
    const fineDetailDiv = document.getElementById('fine-detail');
    const proceedBtn = document.getElementById('proceed-to-payment-btn');
    const restrictionMsg = document.getElementById('payment-restriction-msg');

    fineDisplayArea.style.display = 'none';
    proceedBtn.style.display = 'none';
    restrictionMsg.style.display = 'none';
    
    if (aadhaar.length < 12 || !ruleId || baseFine === 0 || !name || !location) {
        showToast('Please fill in Aadhaar (12 digits), Name, Location, and select a Violation Type.', true);
        return;
    }

    // 2. Calculate progressive fine and check outstanding history
    try {
        const { progressiveCount: previousViolations, totalOutstanding, passengerId, aadhaar: fetchedAadhaar } =
            await getPassengerFineData(aadhaar, ruleId);

        if (baseFine === 0) {
            showToast('Error: Selected violation type has a base fine of ₹0 or rule details could not be retrieved.', true);
            return;
        }

        const currentViolationCount = previousViolations + 1;
        const progressiveFine = baseFine * currentViolationCount;
        
        // BUSINESS RULE: TCs only collect the CURRENT progressive fine.
        const finalBilledAmount = progressiveFine; // Outstanding debt is NOT added here.
        
        const hasUnpaid = totalOutstanding > 0;
        
        // 3. Store calculated data globally
        currentViolationData = {
            isNewViolation: true, // Flag for new violation
            id: null,
            name, mobile, aadhaar: fetchedAadhaar || aadhaar, dob, address, location, ruleId, remarks, 
            finalBilledAmount: finalBilledAmount, // Only the current fine amount
            progressiveFine: progressiveFine,     // Progressive fine amount
            totalOutstanding: totalOutstanding,   // Total outstanding debt (for display/restriction)
            hasUnpaid, 
            passengerId
        };


        // 4. Update UI with results
        finalFineAmountH1.textContent = formatCurrency(finalBilledAmount);
        
        let ruleName = ruleOption.textContent.split(' (Base:')[0];
        let detailMsg = `
            <p><strong>Rule:</strong> ${ruleName}</p>
            <p><strong>Base Fine:</strong> ${formatCurrency(baseFine)}</p>
            <p><strong>Violation Attempt:</strong> #${currentViolationCount} (Current Fine: ${formatCurrency(progressiveFine)})</p>
        `;
        
        if (totalOutstanding > 0) {
            detailMsg += `<p style="color: var(--color-danger);">**Outstanding Debt Found:** ${formatCurrency(totalOutstanding)} (Must be paid separately via public portal).</p>`;
        }
        detailMsg += `<p>Total Passenger Violations Found: ${previousViolations}</p>`;

        fineDetailDiv.innerHTML = detailMsg;
        fineDisplayArea.style.display = 'block';
        proceedBtn.style.display = 'block';
        
        // BUSINESS RULE: If outstanding debt exists, Pay Later is NOT an option for the CURRENT fine.
        if (hasUnpaid) {
            restrictionMsg.style.display = 'block';
        }

    } catch (e) {
        console.error("Error calculating fine:", e);
        showToast(`Failed to calculate fine: ${e.message}`, true);
        finalFineAmountH1.textContent = 'Error';
        fineDetailDiv.textContent = 'Failed to calculate fine. Check console.';
    }
}

/**
 * Function to initiate the payment flow (redirect to payment.html)
 */
function initiatePaymentFlow() {
    if (!currentViolationData || !currentViolationData.finalBilledAmount) {
        showToast('Please calculate the fine first.', true);
        return;
    }

    // Pass data as encoded URL parameters for simpler state management between pages
    const encodedData = btoa(encodeURIComponent(JSON.stringify(currentViolationData)));
    window.location.href = `payment.html?data=${encodedData}`;
}


/**
 * NEW: Generic reusable function for staff to process payment for an existing unpaid fine.
 * NOTE: For existing fines, the entire fine amount is collected, and payment is mandatory.
 */
window.processFinePaymentForStaff = (violationId, amount, passengerName) => {
    // Set global state for processing existing fine payment
    const paymentData = {
        isNewViolation: false, 
        id: violationId,
        finalBilledAmount: amount, // The full amount of the existing fine
        name: passengerName,
        hasUnpaid: true, // Always true for an outstanding fine being collected
        receiptUID: 'Existing Fine', 
    };
    
    const encodedData = btoa(encodeURIComponent(JSON.stringify(paymentData)));
    window.location.href = `payment.html?data=${encodedData}`;
}

/**
 * Function to finalize payment for an existing OUTSTANDING fine (Staff Portal).
 * Generates a Transaction ID and updates status.
 * @param {string} violationId - The ID of the violation to update.
 * @param {string} backToPage - Page to return to after processing.
 * @param {string} paymentMode - 'CASH' or 'UPI'.
 */
async function finalizeOutstandingPayment(violationId, backToPage, paymentMode) {
    if (!violationId) {
        showToast('Error: Missing violation ID.', true);
        return;
    }
    
    const transactionUID = paymentMode === 'CASH' ? null : generateTransactionUID();

    try {
        // Simulate payment process
        showToast('Processing payment confirmation... (Simulated)', false);
        await new Promise(resolve => setTimeout(resolve, 500)); 

        const { error } = await Supabase
            .from('violations')
            .update({ 
                status: 'paid', 
                transaction_uid: transactionUID,
                payment_mode: paymentMode 
            })
            .eq('id', violationId);

        if (error) throw error;
        
        const txnDisplay = transactionUID ? `TXN: ${transactionUID}` : `Mode: CASH`;
        showToast(`Fine successfully collected and status updated to PAID! ${txnDisplay}`, false);
        
        // Redirect back to the originating page
        setTimeout(() => {
            window.location.href = backToPage;
        }, 1500);

    } catch (e) {
        console.error("Error finalizing outstanding payment:", e);
        showToast(`Failed to update fine status: ${e.message}`, true);
    }
}

/**
 * NEW: Generates the HTML receipt (styled as PDF)
 */
async function generateReceiptHTML(violationData) {
    const statusText = violationData.status.toUpperCase();
    const isPaid = statusText === 'PAID';
    
    // 1. Fetch related data (TC name, Rule name, and passenger details including Aadhaar)
    // NOTE: This call relies on the receiptData containing the violation ID (v.id)
    const { data: violationDetails, error: fetchError } = await Supabase
        .from('violations')
        .select(`
            *,
            rules (name),
            tc_profile:profiles!tc_id (full_name),
            passengers (name, mobile, aadhaar_number, date_of_birth, address)
        `)
        .eq('id', violationData.id || -1) 
        .single();
    
    if (fetchError || !violationDetails) {
        console.error("Failed to fetch receipt details:", fetchError);
        return `<div class="receipt-box empty-state error">Error: Could not retrieve full violation details for receipt. (Violation ID: ${violationData.id || 'N/A'})</div>`;
    }
    
    const receiptDate = formatDate(violationDetails.created_at);
    const tcName = violationDetails.tc_profile?.full_name || 'N/A';
    const ruleName = violationDetails.rules?.name || 'Unknown Rule';
    const passengerAadhaar = violationDetails.passengers?.aadhaar_number || 'N/A';
    const passengerName = violationDetails.passengers?.name || 'N/A';
    const passengerMobile = violationDetails.passengers?.mobile || 'N/A';


    // Transaction ID logic: TXN ID only generated for online/UPI payments
    const transactionIDDisplay = (isPaid && violationDetails.transaction_uid)
        ? `<span style="font-weight: 700;">${violationDetails.transaction_uid}</span>`
        : `<span style="font-weight: 700; color: var(--color-danger);">N/A (Unpaid or Cash)</span>`;
        
    const paymentModeDisplay = violationDetails.payment_mode || (isPaid ? 'ONLINE_PUBLIC' : 'N/A');

    const finalReceiptData = {
        ...violationData,
        tcName: tcName,
        ruleName: ruleName,
        receiptDate: receiptDate,
        fineAmount: violationDetails.fine_amount,
    };
    
    // Store for potential re-display
    lastGeneratedReceipt = finalReceiptData;
    
    // Use fixed colors/styles for the receipt generation since it's meant for printing/PDF
    return `
        <div class="receipt-box" style="
            border: 2px solid ${isPaid ? '#28a745' : '#dc3545'}; 
            padding: 30px; 
            background-color: white;
            box-shadow: 0 0 10px rgba(0,0,0,0.1);
            max-width: 600px;
            margin: 20px auto;
            position: relative; /* Required for Watermark Positioning */
            overflow: hidden;
        ">
            <div style="
                position: absolute;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%) rotate(0deg);
                opacity: 0.14; /* Very faint transparency */
                z-index: 1;
                pointer-events: none;
                width: 70%;
            ">
                <img src="logo.png" style="width: 100%; filter: grayscale(100%);">
            </div>

            <div style="position: relative; z-index: 1; text-align: center; margin-bottom: 20px;">
                <img src="logo.png" style="height: 60px; margin-bottom: 10px;">
                <h2 style="color: #003366; border-bottom: 3px solid #ff9933; padding-bottom: 10px; font-size: 1.5rem; margin: 0;">
                    OFFICIAL VIOLATION RECEIPT
                </h2>
            </div>

            <div style="position: relative; z-index: 1;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 15px; padding-bottom: 10px; border-bottom: 1px solid #eee;">
                    <p style="font-size: 0.9rem;"><strong>Date:</strong> ${receiptDate}</p>
                    <p style="font-size: 0.9rem;"><strong>Status:</strong> <span style="color: ${isPaid ? '#28a745' : '#dc3545'}; font-weight: 700;">${statusText}</span></p>
                </div>
             </div>
            
            <div style="margin-bottom: 20px; background-color: #f7f7f7; padding: 15px; border-radius: 6px;">
                <p style="font-size: 1.1rem; margin-bottom: 5px;"><strong>Violation Reference No:</strong> <span style="font-weight: 700; color: #004d80;">${violationDetails.receipt_uid || 'N/A'}</span></p>
                <p style="font-size: 1.1rem; margin-bottom: 5px;"><strong>Transaction ID:</strong> ${transactionIDDisplay}</p>
                <p style="font-size: 1.1rem;"><strong>Payment Mode:</strong> <span style="font-weight: 700;">${paymentModeDisplay}</span></p>
            </div>
            
            <table style="width: 100%; margin-bottom: 20px; font-size: 0.95rem;">
                <tr><td style="padding: 5px 0; width: 40%; border-bottom: 1px dashed #eee;"><strong>Passenger Name:</strong></td><td style="padding: 5px 0; border-bottom: 1px dashed #eee;">${passengerName}</td></tr>
                <tr><td style="padding: 5px 0; width: 40%; border-bottom: 1px dashed #eee;"><strong>Mobile No:</strong></td><td style="padding: 5px 0; border-bottom: 1px dashed #eee;">${passengerMobile}</td></tr>
                <tr><td style="padding: 5px 0; width: 40%; border-bottom: 1px dashed #eee;"><strong>Aadhaar No:</strong></td><td style="padding: 5px 0; border-bottom: 1px dashed #eee;">${passengerAadhaar}</td></tr>
                <tr><td style="padding: 5px 0; width: 40%; border-bottom: 1px dashed #eee;"><strong>Violation Type:</strong></td><td style="padding: 5px 0; border-bottom: 1px dashed #eee;">${ruleName}</td></tr>
                <tr><td style="padding: 5px 0; width: 40%; border-bottom: 1px dashed #eee;"><strong>Fined By (TC):</strong></td><td style="padding: 5px 0; border-bottom: 1px dashed #eee;">${tcName}</td></tr>
                <tr><td style="padding: 5px 0; width: 40%; border-bottom: none;"><strong>Location:</strong></td><td style="padding: 5px 0; border-bottom: none;">${violationDetails.location || 'N/A'}</td></tr>
            </table>

            <div style="text-align: center; background-color: ${isPaid ? '#28a745' : '#004d80'}; color: white; padding: 15px; border-radius: 6px;">
                <p style="font-size: 1.2rem; margin-bottom: 5px;"><strong>Amount Charged:</strong></p>
                <h3 style="font-size: 2.5rem; color: #ff9933; margin: 0; text-shadow: 1px 1px 2px rgba(0,0,0,0.3);">
                    ${formatCurrency(violationDetails.fine_amount)}
                </h3>
            </div>
            
            <p style="font-size: 0.8rem; text-align: center; margin-top: 20px; color: #666;">
                This document serves as proof of record/payment for violation ${violationDetails.receipt_uid}.
            </p>
        </div>
    `;
}

/**
 * NEW: Handles the display of the receipt HTML and prints it.
 * This is primarily used by the button on payment.html
 */
window.displayAndPrintReceipt = async (receiptData) => {
    showToast('Preparing receipt for print/PDF...', false);
    
    const html = await generateReceiptHTML(receiptData);

    const printWindow = window.open('', '', 'height=600,width=800');
    printWindow.document.write('<html><head><title>Violation Receipt</title>');
    
    // Inject custom styles for printing to ensure a clean PDF/Printout
    printWindow.document.write(`
        <style>
            @media print {
                body { margin: 0; padding: 0; background: none; }
                .receipt-box { 
                    border: 2px solid black !important;
                    box-shadow: none !important;
                    margin: 0 auto !important;
                    max-width: 100% !important;
                    padding: 20px;
                }
            }
            body { font-family: 'Inter', sans-serif; background-color: #f0f3f7; }
            h2, h3 { color: #003366; }
            .receipt-box strong { font-weight: 700; }
        </style>
    `);
    
    printWindow.document.write('</head><body>');
    printWindow.document.write(html);
    printWindow.document.write('</body></html>');
    printWindow.document.close();
    
    // Wait for content to render before calling print
    printWindow.onload = () => {
        printWindow.print();
    };
};

/**
 * Function to finalize payment for a NEW fine.
 * Generates Transaction ID and updates status.
 * @param {string} paymentStatus - 'paid' or 'unpaid'
 * @param {string} mode - 'CASH', 'UPI', or 'N/A'
 */
async function finalizeNewViolation(paymentStatus, mode) {
    let transactionUID = null;
    let paymentMode = 'N/A';
    
    if (paymentStatus === 'paid') {
        paymentMode = mode;
        if (mode === 'UPI') {
            transactionUID = generateTransactionUID();
        }
        // If mode is 'CASH', transactionUID remains null, and paymentMode is 'CASH'.
    }
    
    const success = await addViolation(paymentStatus, transactionUID, paymentMode);
    
    if (success) {
        // Redirect to the dedicated receipt page
        const encodedReceiptData = btoa(encodeURIComponent(JSON.stringify(lastGeneratedReceipt)));
        window.location.href = `receipt.html?receiptData=${encodedReceiptData}`;
    }
}


/**
 * Function to set up the payment.html page
 */
function setupPaymentPage() {
    const urlParams = new URLSearchParams(window.location.search);
    const encodedData = urlParams.get('data');
    const encodedReceiptData = urlParams.get('receiptData'); // This should only be present if navigated from an outdated link

    // Check if the old receipt view mode is being used and redirect it to the new dedicated page
    if (encodedReceiptData) {
        window.location.href = `receipt.html?receiptData=${encodedReceiptData}`;
        return;
    }
    
    const paymentFormArea = document.getElementById('payment-form-area');
    // const receiptArea = document.getElementById('receipt-area'); // Removed element
    const returnButton = document.getElementById('cancel-payment-btn');

    // // Hide receipt area on load for payment selection mode
    // if (receiptArea) receiptArea.style.display = 'none';

    // --- PAYMENT SELECTION MODE (Staff Only) ---
    
    if (!encodedData) {
        showToast('Error: Violation data missing. Returning to dashboard.', true);
        setTimeout(() => { 
            // If encodedData is missing, this is the staff payment flow. The user should return to index/dashboard.
            window.location.href = userRole ? (userRole === 'super_admin' ? 'superadmin_dashboard.html' : (userRole === 'station_manager' ? 'admin_dashboard.html' : 'tte_dashboard.html')) : 'index.html';
        }, 1000);
        return;
    }
    
    paymentFormArea.style.display = 'block';

    try {
        // FIX: Use decodeURIComponent to handle potential URL encoding before atob
        currentViolationData = JSON.parse(decodeURIComponent(atob(encodedData)));
    } catch (e) {
        showToast('Error decoding violation data. Returning to dashboard.', true);
        setTimeout(() => { 
            window.location.href = 'index.html'; // Fallback
        }, 1000);
        return;
    }
    
    const data = currentViolationData;
    const isNewViolation = data.isNewViolation === true;
    const isRestricted = data.hasUnpaid;
    
    // FIX: Determine the correct return page based on the current user's role
    let returnPage = 'tte_dashboard.html';
    // Only check userRole if it has been successfully determined by protectPage()
    if (userRole === 'super_admin') {
        returnPage = 'superadmin_dashboard.html';
    } else if (userRole === 'station_manager') {
        returnPage = 'admin_dashboard.html'; // Corrected return page for Manager
    } 

    // Update Summary Display
    document.getElementById('summary-receipt-id').textContent = data.receiptUID || (isNewViolation ? 'NEW VIOLATION' : data.id); // Use ID for existing fine for reference
    document.getElementById('summary-passenger-name').textContent = data.name || 'N/A';
    document.getElementById('summary-amount').textContent = formatCurrency(data.finalBilledAmount);
    
    document.getElementById('upi-amount').textContent = formatCurrency(data.finalBilledAmount);

    const finalActionsDiv = document.getElementById('final-actions');
    const payCashBtn = document.getElementById('pay-cash');
    const payUpiBtn = document.getElementById('pay-upi');
    
    // Set up button handlers (listeners are attached in DOMContentLoaded)
    
    // Resetting the Cancel button action
    returnButton.textContent = 'Cancel & Return';
    returnButton.onclick = () => {
        if (isNewViolation) {
            window.location.href = 'add_violation.html'; 
        } else {
            window.location.href = returnPage;
        }
    };


    if (isNewViolation && isRestricted) {
        // New violation + debt: must pay now.
        showToast('Mandatory: Outstanding debt found. Payment for the CURRENT fine is required now.', true);
        // Pay Later button remains hidden/absent.
    } else if (isNewViolation && !isRestricted) {
        // New violation + no debt: can pay later.
        finalActionsDiv.innerHTML = `
            <button id="submit-pay-later-btn" class="btn btn-danger" style="width: 100%; margin-top: 20px;">
                Pay Later (Record as UNPAID)
            </button>
        `;
        // Use the new finalization function for new violations
        document.getElementById('submit-pay-later-btn').addEventListener('click', () => {
            showToast("Recording as UNPAID. The passenger will incur progressive fines.", true);
            finalizeNewViolation('unpaid', 'N/A'); // 'N/A' mode for unpaid fines
        });
    }
    // If not a new violation, only Pay Now buttons are relevant, Pay Later remains hidden/absent.
}

/**
 * Handles the selection of a payment method (Cash or UPI)
 * @param {string} mode - 'CASH' or 'UPI'
 * @param {boolean} isNew - True if processing a new violation, false if settling an existing fine.
 * @param {boolean} isRestricted - True if outstanding debt exists (only relevant for new fines).
 */
function handlePaymentSelection(mode, isNew, isRestricted) {
    const finalActionsDiv = document.getElementById('final-actions');
    const upiSimDiv = document.getElementById('upi-simulation');
    const data = currentViolationData;
    
    // Determine return page for existing fines
    let returnPage = 'tte_dashboard.html';
    if (userRole === 'super_admin') {
        returnPage = 'superadmin_dashboard.html';
    } else if (userRole === 'station_manager') {
        returnPage = 'admin_dashboard.html';
    } 

    // Reset UI
    upiSimDiv.style.display = 'none';
    
    // Clear dynamic elements in finalActionsDiv, potentially preserving Pay Later button if it exists
    finalActionsDiv.innerHTML = ''; 
    
    // Re-add Pay Later button if it exists and conditions allow (new violation, no restriction)
    if (isNew && !isRestricted) {
        finalActionsDiv.innerHTML = `
            <button id="submit-pay-later-btn" class="btn btn-danger" style="width: 100%; margin-top: 20px;">
                Pay Later (Record as UNPAID)
            </button>
        `;
         document.getElementById('submit-pay-later-btn').addEventListener('click', () => {
            showToast("Recording as UNPAID. The passenger will incur progressive fines.", true);
            finalizeNewViolation('unpaid', 'N/A');
        });
    }
    

    let finalizationHtml = '';
    
    // The action depends on whether it's a new violation or an existing one
    const finalizeAction = isNew 
        ? `finalizeNewViolation('paid', '${mode}')` // Pass mode for new violation
        : `finalizeOutstandingPayment('${data.id}', '${returnPage}', '${mode}')`; // Pass mode for existing fine

    
    if (mode === 'CASH') {
        finalizationHtml = `
            <div class="card empty-state success" style="margin-top: 20px;">
                <p>Confirm: Received ${formatCurrency(data.finalBilledAmount)} in Cash.</p>
                <button id="finalize-cash-btn" class="btn btn-success" style="margin-top: 10px;">Finalize Cash Payment</button>
            </div>
        `;
    } else if (mode === 'UPI') {
        // Show UPI Simulation area
        upiSimDiv.style.display = 'block';
        finalizationHtml = `
            <div class="card empty-state success" style="margin-top: 20px;">
                <p>Assume UPI payment is confirmed by the system.</p>
                <button id="finalize-upi-btn" class="btn btn-success" style="margin-top: 10px;">Finalize UPI Payment</button>
            </div>
        `;
    }
    
    // Append the new finalization options
    finalActionsDiv.innerHTML += finalizationHtml;

    // Attach Finalize Listener
    const finalizeBtn = document.getElementById(`finalize-${mode.toLowerCase()}-btn`);
    if (finalizeBtn) {
        // Inject the correct logic based on whether it's a new or existing fine
        finalizeBtn.setAttribute('onclick', finalizeAction);
    }
    
    showToast(`${mode} selected. Ready to finalize.`, false);
}


function setupViolationForm() {
    const ruleSelect = document.getElementById('violation-type');

    (async () => {
        try {
            const { data: rules, error } = await Supabase.from('rules').select('*').order('name', { ascending: true });
            if (error) throw error;

            ruleSelect.innerHTML = '<option value="" disabled selected>Select a violation type</option>';
            rules.forEach(rule => {
                const option = document.createElement('option');
                option.value = rule.id;
                option.textContent = `${rule.name} (Base: ${formatCurrency(rule.base_fine)})`;
                option.dataset.baseFine = rule.base_fine; 
                ruleSelect.appendChild(option);
            });
        } catch (e) {
            console.error("Error loading rules:", e);
            showToast('Failed to load violation types.', true);
            ruleSelect.innerHTML = '<option value="" disabled selected>Error loading rules</option>';
            ruleSelect.disabled = true;
        }
    })();

    const calculateBtn = document.getElementById('calculate-fine-btn');
    if (calculateBtn) {
        calculateBtn.addEventListener('click', calculateFineAndHistory);
    }
    
    const proceedBtn = document.getElementById('proceed-to-payment-btn');
    if (proceedBtn) {
        proceedBtn.addEventListener('click', initiatePaymentFlow);
    }

   // Change 'editBtn' to 'passengerEditBtn' to avoid redeclaration errors
    const passengerEditBtn = document.getElementById('enable-edit-btn');
    if (passengerEditBtn) {
        passengerEditBtn.addEventListener('click', enablePassengerEditing);
    }

    // Add these listeners near your existing calculateBtn listener
    const fetchBtn = document.getElementById('fetch-passenger-btn');
    if (fetchBtn) {
        fetchBtn.addEventListener('click', fetchPassengerByAadhaar);
    }

    const editBtn = document.getElementById('enable-edit-btn');
    if (editBtn) {
        editBtn.addEventListener('click', enablePassengerEditing);
    }
}


// --- PASSENGER PROFILE UPDATE MODAL LOGIC (Used for TTE's Integrated Search Results) ---

function setupPassengerUpdateModal() {
    const modal = document.getElementById('passenger-update-modal');
    if (!modal) return;
    
    const closeModalBtn = document.querySelector('#passenger-update-modal .close-btn');
    const form = document.getElementById('update-passenger-form');
    
    closeModalBtn.onclick = () => { modal.style.display = 'none'; };
    window.onclick = (event) => {
        if (event.target === modal) {
            modal.style.display = 'none';
        }
    };
    
    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const id = document.getElementById('update-p-id').value;
            const name = document.getElementById('update-p-name').value.trim();
            const mobile = document.getElementById('update-p-mobile').value.trim();
            const address = document.getElementById('update-p-address').value.trim();
            const dob = document.getElementById('update-p-dob').value.trim();
            
            await updatePassengerDetails(id, name, mobile, address, dob);
            modal.style.display = 'none';
            
            // Re-run search after update, assuming the user was on the TTE dashboard
            const currentPageName = window.location.pathname.split('/').pop();
            if (currentPageName === 'tte_dashboard.html') {
                 searchTteViolations(document.getElementById('search-term')?.value.trim() || '', document.getElementById('search-date')?.value.trim() || '');
            }
        });
    }
}

window.openPassengerUpdateModal = (passengerId, name, mobile, address, dob) => {
    const modal = document.getElementById('passenger-update-modal');
    
    document.getElementById('update-p-id').value = passengerId;
    document.getElementById('update-p-name').value = name;
    document.getElementById('update-p-mobile').value = mobile;
    document.getElementById('update-p-address').value = address;
    document.getElementById('update-p-dob').value = dob;
    
    modal.style.display = 'block';
};


/**
 * NEW: Generic function for TTE to search their own logged violations.
 * Integrated into tte_dashboard.html
 */
async function searchTteViolations(searchTerm = '', searchDate = '', showAll = false) {
    
    const { data: { session } } = await Supabase.auth.getSession();
    const tteId = session?.user?.id;
    if (!tteId) {
        showToast('Authentication error. Please log in again.', true);
        return;
    }
    
    const resultsBody = document.getElementById('tte-search-results-body');
    const resultsTable = document.getElementById('tte-results-table');
    const initialPrompt = document.getElementById('initial-search-prompt');
    
    resultsBody.innerHTML = '<tr><td colspan="8" class="text-center">Searching your records...</td></tr>'; // Updated colspan
    // FIX: Ensure the table is visible when search is executed
    if (resultsTable) resultsTable.style.display = 'table';
    if (initialPrompt) initialPrompt.style.display = 'none'; // Check if element exists

    let query = Supabase
        .from('violations')
        .select(`
            id,
            created_at,
            fine_amount,
            status,
            location,
            receipt_uid,
            transaction_uid,
            remarks,
            rules (name),
            passengers (id, name, aadhaar_number, mobile, address, date_of_birth)
        `) // Fetch all passenger details
        .eq('tc_id', tteId) // CRUCIAL: Filter by current TTE's ID
        .order('created_at', { ascending: false });

    
    // 1. Filter by Date (DB side filtering)
    if (searchDate) {
        const dateStart = searchDate + 'T00:00:00.000Z';
        const dateEnd = searchDate + 'T23:59:59.999Z';
        query = query.gte('created_at', dateStart).lte('created_at', dateEnd);
    }

    const { data: violations, error: vError } = await query;
    
    if (vError) {
        console.error('Error fetching TTE violations:', vError);
        resultsBody.innerHTML = `<tr><td colspan="8" class="text-center error">Error loading records. Check console for RLS policy issues.</td></tr>`; // Updated colspan
        if (resultsTable) resultsTable.style.display = 'table'; // Keep table visible to show error
        return;
    }

    let filteredViolations = violations || [];
    
    // 2. Client-side Search Term Refinement (Name, Aadhaar, Location, Receipt ID)
    if (searchTerm) {
        const lowerSearchTerm = searchTerm.toLowerCase();
        filteredViolations = violations.filter(v => 
            v.passengers?.name?.toLowerCase().includes(lowerSearchTerm) ||
            v.passengers?.aadhaar_number?.includes(lowerSearchTerm) ||
            v.location?.toLowerCase().includes(lowerSearchTerm) ||
            v.receipt_uid?.toLowerCase().includes(lowerSearchTerm)
        );
    }
    
    // 3. Display Results
    resultsBody.innerHTML = '';
    
    if (filteredViolations.length === 0) {
         resultsBody.innerHTML = `<tr><td colspan="8" class="text-center empty-state">No records matched your search term or date.</td></tr>`; // Updated colspan
         return;
    }


    filteredViolations.forEach(v => {
        const statusColor = v.status === 'paid' ? 'var(--color-success)' : 'var(--color-danger)';
        const p = v.passengers;
        
        // Button to collect fine (only visible if unpaid)
        const payOptionHtml = v.status === 'unpaid' 
            ? `<button class="btn btn-success btn-edit-sm" onclick="processFinePaymentForStaff('${v.id}', ${v.fine_amount}, '${p?.name || 'N/A'}')">Collect Fine</button>`
            : 'N/A';
            
        // FIX: Added Update Profile button for the TTE to manage passenger details
        const updateButtonHtml = p?.id 
            ? `<button class="btn btn-primary btn-edit-sm" onclick="openPassengerUpdateModal(
                '${p.id}', 
                '${p.name || ''}', 
                '${p.mobile || ''}', 
                '${(p.address || '').replace(/\n/g, '\\n')}', 
                '${p.date_of_birth || ''}'
            )">Update Profile</button>`
            : '';

        
        const row = resultsBody.insertRow();
        row.innerHTML = `
            <td>${formatDate(v.created_at)}</td>
            <td>${p?.name || 'N/A'}</td>
            <td>${p?.aadhaar_number || 'N/A'}</td>
            <td style="font-weight: 600;">${formatCurrency(v.fine_amount)}</td>
            <td style="color: ${statusColor}; font-weight: 600;">${v.status.toUpperCase()}</td>
            <td>Location: ${v.location}<br>Receipt: ${v.receipt_uid}<br>TXN: ${v.transaction_uid || 'N/A'}</td>
            <td>${payOptionHtml}</td>
            <td>${updateButtonHtml}</td>
        `;
    });
}

/**
 * Function to handle a TTE collecting an outstanding fine in the dashboard view.
 * NOTE: This is deprecated/redundant now that processFinePaymentForStaff is implemented.
 */
window.processOutstandingFineCollection = async (violationId) => {
    // This logic is now handled by redirecting to payment.html via processFinePaymentForStaff
    showToast('Function deprecated. Please use Collect Fine button to open the payment page.', true);
}


// --- 7. PUBLIC FUNCTIONS (Used on index.html, helpdesk.html, passenger_payment_portal.html) ---

async function loadPublicRules() {
    const rulesListDiv = document.getElementById('public-rules-list');
    rulesListDiv.innerHTML = '<p class="text-center">Loading official rules...</p>';

    try {
        const { data: rules, error } = await Supabase
            .from('rules')
            .select('*')
            .eq('is_active', true) 
            .order('name', { ascending: true });

        if (error) throw error;

        let html = '<h3>Official Violation Rules (Base Fines)</h3>';
        html += '<div class="table-responsive"><table class="data-table" style="margin-top: 10px;">';
        html += '<thead><tr><th>Violation Type</th><th>Base Fine (₹)</th><th>Progressive Formula</th></tr></thead><tbody>';

        if (rules.length === 0) {
            html += `<tr><td colspan="3" class="text-center">No active rules currently defined.</td></tr>`;
        } else {
            rules.forEach(rule => {
                const row = `
                    <tr>
                        <td>${rule.name}</td>
                        <td style="font-weight: 600;">${formatCurrency(rule.base_fine)}</td>
                        <td>Base Fine &times; (Violation Count)</td>
                        </tr>
                `;
                 html += row;
            });
        }

        html += '</tbody></table></div>';
        html += '<p style="margin-top: 10px; font-style: italic; color: var(--color-danger);">Note: Final fine includes outstanding debts and progressive increase.</p>';
        rulesListDiv.innerHTML = html;

    } catch (e) {
        console.error("Error loading public rules:", e);
        rulesListDiv.innerHTML = `<p class="text-center" style="color: var(--color-danger);">Failed to load rules.</p>`;
        showToast(`Failed to load public rules: ${e.message}`, true);
    }
}

/**
 * Public function to redirect to the new UPI-only payment portal for an outstanding fine.
 */
window.initiatePublicPaymentRedirect = (violationId, amount, receiptUID, passengerName) => {
    const paymentData = {
        id: violationId,
        fineAmount: amount,
        receiptUID: receiptUID,
        name: passengerName,
        isNewViolation: false // Critical: flags this as an existing fine payment
    };
    // FIX: Using encodeURIComponent for clean URL transfer
    const encodedData = btoa(encodeURIComponent(JSON.stringify(paymentData)));
    window.location.href = `passenger_payment_portal.html?data=${encodedData}`;
};


/**
 * Fetches all fines and separates them into 'Outstanding' (for payment) and 'History'.
 */
async function searchOutstandingFines(identifier) {
    const resultDiv = document.getElementById('fine-results');
    resultDiv.innerHTML = '<div class="empty-state">Searching...</div>';

    if (!identifier) {
        showToast('Please enter your Mobile or Aadhaar number.', true);
        resultDiv.innerHTML = '';
        return;
    }

    try {
        let { data: passengers, error: pError } = await Supabase
            .from('passengers')
            .select('id, name, aadhaar_number, mobile') // Fetch all required passenger details
            .or(`mobile.eq.${identifier},aadhaar_number.eq.${identifier}`)
            .limit(1);

        if (pError) throw pError;

        if (!passengers || passengers.length === 0) {
            resultDiv.innerHTML = `<div class="empty-state">No passenger found with that identifier.</div>`;
            return;
        }

        // NOTE: passenger object contains id, name, aadhaar_number, mobile
        const passenger = passengers[0];
        const passengerId = passenger.id;

        // 1. Fetch ALL violations (paid and unpaid)
        const { data: violations, error: vError } = await Supabase
            .from('violations')
            .select(`
                id,
                created_at,
                fine_amount,
                status,
                receipt_uid,
                rules (name),
                tc_id 
            `) 
            .eq('passenger_id', passengerId)
            .order('created_at', { ascending: false }); // Latest first

        if (vError) throw vError;
        
        // 2. Separate Fines
        const outstandingFines = (violations || []).filter(v => v.status === 'unpaid');
        const totalOutstanding = outstandingFines.reduce((sum, v) => sum + v.fine_amount, 0);

        let html = '';

        // --- OUTSTANDING FINES SECTION (Payment) ---
        if (outstandingFines.length > 0) {
            html += `<div class="card" style="border-left: 5px solid var(--color-danger); margin-bottom: 20px;">
                            <h3>Total Outstanding Fines for **${passenger.name}**</h3>
                            <p style="font-size: 1.5rem; color: var(--color-danger); font-weight: bold; margin-bottom: 15px;">Total Due: ${formatCurrency(totalOutstanding)}</p>
                        </div>`;

            outstandingFines.forEach(v => {
                // Prepare JSON data for payment redirect
                const fineData = JSON.stringify({
                    id: v.id,
                    fineAmount: v.fine_amount,
                    receiptUID: v.receipt_uid,
                    name: passenger.name
                }).replace(/"/g, '&quot;');
                
                html += `
                    <div class="card fine-item" style="padding: 15px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; border-left: 4px solid var(--color-danger);">
                        <div>
                            <p><strong>Receipt ID:</strong> ${v.receipt_uid}</p>
                            <p><strong>Violation:</strong> ${v.rules?.name || 'N/A'}</p>
                            <p><strong>Date:</strong> ${formatDate(v.created_at)}</p>
                        </div>
                        <div style="text-align: right;">
                            <p style="font-weight: bold; font-size: 1.2rem; color: var(--color-danger);">${formatCurrency(v.fine_amount)}</p>
                            <button class="btn btn-success btn-pay-now" 
                                data-id="${v.id}" 
                                data-amount="${v.fine_amount}" 
                                data-receipt="${v.receipt_uid}"
                                data-p-name="${passenger.name}">Pay Now</button>
                        </div>
                    </div>
                `;
            });
            
            html += `<hr style="margin: 40px 0;">`;
            
        } else if (violations.length === 0) {
            // No fines at all
            resultDiv.innerHTML = `<div class="empty-state success" style="color: var(--color-success); border: 1px solid var(--color-success);">Welcome! No violation history found for ${passenger.name}.</div>`;
            return;
        } else {
            // All fines are paid, show success message before history
            html += `<div class="empty-state success" style="color: var(--color-success); border: 1px solid var(--color-success); margin-bottom: 30px;">
                        Congratulations! All fines for **${passenger.name}** have been cleared.
                     </div>`;
        }
        
        // --- FULL VIOLATION HISTORY SECTION ---
        if (violations.length > 0) {
            html += `<h3 style="margin-top: 15px; margin-bottom: 15px; color: var(--color-primary-dark);">Full Violation History (${violations.length} Records)</h3>
                     <div class="table-responsive card" style="padding: 0;">
                        <table class="data-table">
                            <thead>
                                <tr>
                                    <th>Date</th>
                                    <th>Violation Type</th>
                                    <th>Fine (₹)</th>
                                    <th>Status</th>
                                    <th>Receipt ID</th>
                                    <th>Action</th>
                                </tr>
                            </thead>
                            <tbody>`;
                            
            (violations || []).forEach(v => {
                const statusColor = v.status === 'paid' ? 'var(--color-success)' : 'var(--color-danger)';
                    
                // Data needed for the View Receipt button to send to the dedicated receipt page
                const violationReceiptData = JSON.stringify({
                    id: v.id,
                    name: passenger.name,
                    mobile: passenger.mobile, 
                    aadhaar: passenger.aadhaar_number,
                    receiptUID: v.receipt_uid,
                    status: v.status,
                    fineAmount: v.fine_amount,
                    tcId: v.tc_id, // Needed to fetch TC name for receipt
                    isNewViolation: false
                }).replace(/"/g, '&quot;');

                // Determine action button
                let actionButtonHtml = 'N/A';
                if (v.status === 'paid') {
                    // ACTION BUTTON: View Receipt (For paid fines)
                    actionButtonHtml = `<button class="btn btn-info btn-edit-sm btn-view-receipt" data-receipt='${violationReceiptData}'>View Receipt</button>`;
                }
                // NOTE: If the fine is unpaid, the action is to use the "Pay Now" button above, 
                // but we keep 'N/A' here for the history table row action column consistency.


                html += `
                    <tr>
                        <td>${formatDate(v.created_at)}</td>
                        <td>${v.rules?.name || 'Unknown'}</td>
                        <td style="font-weight: 600;">${formatCurrency(v.fine_amount)}</td>
                        <td style="color: ${statusColor}; font-weight: 600;">${v.status.toUpperCase()}</td>
                        <td>${v.receipt_uid}</td>
                        <td>${actionButtonHtml}</td>
                    </tr>
                `;
            });

            html += '</tbody></table></div>';
        }


        resultDiv.innerHTML = html;

        // 3. Attach event listeners for payment (only if outstanding fines exist)
        if (outstandingFines.length > 0) {
            document.querySelectorAll('.btn-pay-now').forEach(btn => {
                btn.addEventListener('click', () => {
                    // Redirect to new public UPI-only portal
                    window.initiatePublicPaymentRedirect(
                        btn.dataset.id, 
                        parseFloat(btn.dataset.amount), 
                        btn.dataset.receipt, 
                        btn.dataset.pName
                    );
                });
            });
        }
        
        // 4. Attach event listeners for viewing receipts
        document.querySelectorAll('.btn-view-receipt').forEach(btn => {
             btn.addEventListener('click', () => {
                 // FIX: Parse data attribute directly (it was being stringified with quote replacement previously).
                 const receiptData = JSON.parse(btn.dataset.receipt.replace(/&quot;/g, '"'));
                 // FIX: Use encodeURIComponent for reliable URL transfer
                 const encodedReceiptData = btoa(encodeURIComponent(JSON.stringify(receiptData)));
                 // Redirect to the dedicated receipt page
                 window.location.href = `receipt.html?receiptData=${encodedReceiptData}`;
             });
        });


    } catch (e) {
        console.error("Public fine search error:", e);
        showToast(`Search failed: ${e.message}`, true);
        resultDiv.innerHTML = `<div class="empty-state error">An error occurred during search.</div>`;
    }
}

/**
 * Handles the FINALIZATION of payment for an existing fine via the public portal (passenger_payment_portal.html).
 * This simulates an a payment and generates a receipt.
 */
async function finalizePublicOnlinePayment(violationId, amount, receiptUID, passengerName) {
    if (!violationId) return;

    // Simulate online payment: generate TXN ID and set payment mode
    const transactionUID = generateTransactionUID();
    const paymentMode = 'ONLINE_PUBLIC';

    try {
        // Show loading/simulated payment
        showToast('Confirming UPI transaction and updating record...', false);
        await new Promise(resolve => setTimeout(resolve, 1000)); 

        // Update the violation record
        const { data: updatedViolation, error } = await Supabase
            .from('violations')
            .update({ 
                status: 'paid', 
                transaction_uid: transactionUID,
                payment_mode: paymentMode
            })
            .eq('id', violationId)
            .select('*, passengers (name, mobile, aadhaar_number, date_of_birth, address)') // Fetch necessary passenger details
            .single();

        if (error) throw error;
        
        showToast('Payment successful! Status updated. Redirecting to receipt.', false);

        // Construct receipt data
        const passenger = updatedViolation.passengers;
        const receiptData = {
            id: updatedViolation.id,
            name: passenger?.name || passengerName,
            mobile: passenger?.mobile || 'N/A',
            aadhaar: passenger?.aadhaar_number || 'N/A',
            receiptUID: updatedViolation.receipt_uid,
            transactionUID: updatedViolation.transaction_uid,
            status: updatedViolation.status,
            fineAmount: updatedViolation.fine_amount,
            paymentMode: updatedViolation.payment_mode,
            tcId: updatedViolation.tc_id, 
            isNewViolation: false
        };

        // Redirect to the dedicated receipt page
        // FIX: Use encodeURIComponent for reliable URL transfer
        const encodedReceiptData = btoa(encodeURIComponent(JSON.stringify(receiptData)));
        window.location.href = `receipt.html?receiptData=${encodedReceiptData}`;


    } catch (e) {
        console.error("Public Payment finalization failed:", e);
        showToast(`Payment processing failed. Please check the transaction status or contact support. Error: ${e.message}`, true);
    }
}

/**
 * Function to set up the new passenger_payment_portal.html page.
 */
function setupPassengerPaymentPortal() {
    const urlParams = new URLSearchParams(window.location.search);
    const encodedData = urlParams.get('data');
    
    // NOTE: This page is strictly for *paying* an outstanding fine via UPI. 
    // It should not handle receipt viewing, as receipt viewing redirects to receipt.html.
    
    if (!encodedData) {
        showToast('Error: Violation data missing. Returning to home.', true);
        setTimeout(() => { window.location.href = 'index.html'; }, 1000);
        return;
    }

    try {
        // FIX: Use decodeURIComponent to handle potential URL encoding before atob
        currentViolationData = JSON.parse(decodeURIComponent(atob(encodedData)));
    } catch (e) {
        showToast('Error decoding violation data. Returning to home.', true);
        setTimeout(() => { window.location.href = 'index.html'; }, 1000);
        return;
    }
    
    const data = currentViolationData;
    
    // Update Summary Display
    document.getElementById('summary-receipt-id').textContent = data.receiptUID || data.id; 
    document.getElementById('summary-passenger-name').textContent = data.name || 'N/A';
    document.getElementById('summary-amount').textContent = formatCurrency(data.fineAmount);
    document.getElementById('upi-amount').textContent = formatCurrency(data.fineAmount);

    const finalizeBtn = document.getElementById('finalize-upi-btn');
    if (finalizeBtn) {
        finalizeBtn.addEventListener('click', () => {
            finalizePublicOnlinePayment(data.id, data.fineAmount, data.receiptUID, data.name);
        });
    }
}


function setupPublicHomePage() {
    const searchForm = document.getElementById('search-fine-form');
    if (searchForm) {
        searchForm.addEventListener('submit', (e) => {
            e.preventDefault();
            searchOutstandingFines(document.getElementById('search-identifier').value.trim());
        });
    }

    const showRulesBtn = document.getElementById('show-fines-btn');
    const rulesListDiv = document.getElementById('public-rules-list');
    if (showRulesBtn) {
        showRulesBtn.addEventListener('click', async () => {
            if (rulesListDiv.style.display === 'none' || rulesListDiv.innerHTML === '<p class="text-center">Loading official rules...</p>') {
                rulesListDiv.style.display = 'block';
                showRulesBtn.innerHTML = 'Hide Official Fine Rules';
                await loadPublicRules();
            } else {
                rulesListDiv.style.display = 'none';
                showRulesBtn.innerHTML = '📋 View Official Fine Rules';
            }
        });
    }
}

/**
 * Function to set up the new dedicated receipt.html page.
 */
window.setupReceiptPage = async () => {
    const urlParams = new URLSearchParams(window.location.search);
    const encodedReceiptData = urlParams.get('receiptData');
    const receiptOutput = document.getElementById('receipt-output');
    const returnButton = document.getElementById('return-btn');
    const printButton = document.getElementById('print-receipt-btn');

    if (!encodedReceiptData) {
        showToast('Error: Missing receipt data. Returning to home.', true);
        if (receiptOutput) receiptOutput.innerHTML = `<div class="empty-state error">Cannot load receipt: data missing.</div>`;
        if (returnButton) returnButton.textContent = '← Return to Home';
        returnButton.onclick = () => { window.location.href = 'index.html'; };
        return;
    }
    
    try {
        // Decode and Parse data
        const receiptData = JSON.parse(decodeURIComponent(atob(encodedReceiptData)));
        
        if (!receiptData.id && !receiptData.receiptUID) {
            throw new Error("Invalid receipt data structure.");
        }
        
        // Determine return page: Staff goes to Dashboard, Public goes to Home.
        let returnTarget = 'index.html';
        if (userRole === 'super_admin') {
             returnTarget = 'superadmin_dashboard.html';
        } else if (userRole === 'station_manager') {
             returnTarget = 'admin_dashboard.html';
        } else if (userRole === 'tc') {
             returnTarget = 'tte_dashboard.html';
        }
        
        // Update UI
        if (returnButton) {
            returnButton.textContent = returnTarget === 'index.html' ? '← Return to Home Portal' : '← Return to Dashboard';
            returnButton.onclick = () => { window.location.href = returnTarget; };
        }
        
        // Generate and display receipt
        const html = await generateReceiptHTML(receiptData);
        if (receiptOutput) receiptOutput.innerHTML = html;
        
        // Attach print listener
        if (printButton) {
            printButton.onclick = () => {
                window.displayAndPrintReceipt(receiptData);
            };
        }

    } catch (e) {
        console.error("Error setting up receipt page:", e);
        showToast('Error displaying receipt. Data corrupted.', true);
        if (receiptOutput) receiptOutput.innerHTML = `<div class="empty-state error">Error loading receipt: ${e.message}</div>`;
        if (returnButton) returnButton.textContent = '← Return to Home';
        returnButton.onclick = () => { window.location.href = 'index.html'; };
    }
}


// --- GRIEVANCE LOGIC (ENHANCED) ---

/**
 * Handles passenger grievance submission and displays the generated reference number.
 */
async function submitGrievance(e) {
    e.preventDefault();

    const name = document.getElementById('g-name').value.trim();
    const receiptNumber = document.getElementById('g-receipt-number').value.trim();
    const mobile = document.getElementById('g-mobile').value.trim();
    const email = document.getElementById('g-email').value.trim();
    const message = document.getElementById('g-message').value.trim();
    
    if (!name || !receiptNumber || !message) {
        showToast('Please fill in Name, Receipt Number, and your Grievance Message.', true);
        return;
    }

    const grievanceUID = generateGrievanceUID(); // NEW: Generate unique ID

    try {
        const { error } = await Supabase
            .from('grievances')
            .insert([{ 
                passenger_name: name,
                receipt_uid: receiptNumber,
                mobile_number: mobile || null,
                email: email || null,
                message: message,
                status: 'PENDING', // NEW: Initial status
                grievance_uid: grievanceUID // NEW: Unique ID for tracking
            }]);

        if (error) throw error;

        // NEW: Display success message and unique reference number
        showToast(`Grievance submitted successfully! Reference No: ${grievanceUID}`, false);
        document.getElementById('grievance-form').style.display = 'none';
        
        document.getElementById('grievance-submission-result').innerHTML = `
            <div class="empty-state success" style="margin-top: 20px;">
                <p style="font-size: 1.1rem; font-weight: 700;">Grievance Submitted Successfully!</p>
                <p style="font-size: 1.5rem; color: var(--color-primary); margin: 10px 0;">
                    Your Reference Number: <strong>${grievanceUID}</strong>
                </p>
                <p>Please use this number with the 'Track Grievance' tool below to check the status.</p>
                <button type="button" class="btn btn-primary" onclick="document.getElementById('track-grievance-uid').value='${grievanceUID}'; document.getElementById('track-grievance-form').scrollIntoView({ behavior: 'smooth' });">
                    Track Status Now
                </button>
            </div>
        `;
        document.getElementById('grievance-submission-result').style.display = 'block';


    } catch (e) {
        console.error("Error submitting grievance:", e);
        showToast(`Failed to submit grievance: ${e.message}`, true);
    }
}

/**
 * NEW: Tracks the status of a grievance by its unique ID.
 */
async function trackGrievanceStatus(e) {
    e.preventDefault();
    const grievanceUID = document.getElementById('track-grievance-uid').value.trim();
    const trackResultDiv = document.getElementById('grievance-track-result');
    // CRITICAL FIX: Ensure loading state is set clearly before API call
    trackResultDiv.innerHTML = '<div class="empty-state">Searching...</div>';
    trackResultDiv.style.display = 'block';

    if (!grievanceUID) {
        showToast('Please enter the Grievance Reference Number.', true);
        trackResultDiv.innerHTML = '';
        return;
    }

    try {
        // Log the UID being searched for enhanced debugging
        console.log(`Attempting to search for grievance UID: ${grievanceUID}`);
        
        const { data: grievance, error } = await Supabase
            .from('grievances')
            // Public RLS policy must allow read access based on grievance_uid matching.
            .select('*') 
            .eq('grievance_uid', grievanceUID)
            .maybeSingle(); 

        // Log the Supabase response for debugging RLS/fetch issues
        console.log("Supabase query complete. Error:", error, "Data:", grievance);

        if (error) throw error;
        
        // FIX: Display clear "Not Found" message if grievance is null
        if (!grievance) {
            trackResultDiv.innerHTML = `<div class="empty-state error">Grievance **${grievanceUID}** not found. Please check the number or ensure the grievance was submitted successfully.</div>`;
            return;
        }

        const statusColor = grievance.status === 'CLOSED' ? 'var(--color-success)' : (grievance.status === 'PENDING' ? 'var(--color-danger)' : 'var(--color-primary)');
        const statusText = (grievance.status || 'N/A').toUpperCase();
        const remarkDisplay = grievance.superadmin_remark 
            ? `<p style="margin-top: 15px;"><strong>Official Remark:</strong> ${grievance.superadmin_remark}</p>`
            : `<p style="margin-top: 15px; font-style: italic;">No official remark available yet.</p>`;

        trackResultDiv.innerHTML = `
            <div class="card" style="border-left: 6px solid ${statusColor};">
                <h3 style="color: var(--color-primary-dark);">Grievance Status: **${grievanceUID}**</h3>
                <p><strong>Submission Date:</strong> ${formatDate(grievance.created_at)}</p>
                <p><strong>Violation ID:</strong> ${grievance.receipt_uid}</p>
                
                <div style="margin-top: 15px; padding: 10px; border-radius: 6px; background-color: #f0f0f0;">
                    <p style="font-size: 1.2rem; font-weight: 700; color: ${statusColor};">
                        Current Status: ${statusText}
                    </p>
                </div>
                ${remarkDisplay}
            </div>
        `;

    } catch (e) {
        console.error("Error tracking grievance:", e);
        // Fallback for unexpected errors (like RLS violation)
        trackResultDiv.innerHTML = `<div class="empty-state error">An unexpected error occurred during tracking. This might be due to a security policy (RLS) issue. Please check the browser console (F12) for details.</div>`;
        showToast(`Failed to track grievance: ${e.message}.`, true);
    }
}


async function loadGrievanceSection() {
    const tableBody = document.getElementById('grievance-table-body');
    // Ensure colspan is 7 to match table headers
    tableBody.innerHTML = '<tr><td colspan="7" class="text-center">Loading submitted grievances...</td></tr>';
    
    try {
        const { data: grievances, error } = await Supabase
            .from('grievances')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(10); 
            
        if (error) throw error;
        
        tableBody.innerHTML = '';
        
        if (grievances.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="7" class="text-center empty-state success">No pending grievances found.</td></tr>`;
            return;
        }

        (grievances || []).forEach(g => {
            // FIX for TypeError: Ensure status is a string, defaulting if null/undefined
            const status = g.status || 'UNKNOWN'; 
            
            const statusColor = status === 'PENDING' ? 'var(--color-danger)' : (status === 'CLOSED' ? 'var(--color-success)' : 'var(--color-info)');
            const remarkButtonText = status === 'PENDING' ? 'Add Remark & Close' : 'View Remark / Update';
            
            // Prepare data for modal
            const grievanceData = JSON.stringify({
                id: g.id,
                uid: g.grievance_uid || 'N/A',
                message: g.message || 'N/A',
                status: status,
                remark: g.superadmin_remark || ''
            }).replace(/"/g, '&quot;');
            
            row = tableBody.insertRow();
            row.innerHTML = `
                <td>${formatDate(g.created_at)}</td>
                <td>${g.grievance_uid || 'N/A'}</td>
                <td>${g.passenger_name || 'N/A'}</td>
                <td>${g.receipt_uid || 'N/A'}</td>
                <td style="color: ${statusColor}; font-weight: 600;">${status.toUpperCase()}</td>
                <td>${(g.message || 'N/A').substring(0, 50)}...</td>
                <td>
                    <button class="btn btn-info btn-edit-sm" onclick="openGrievanceRemarkModal('${g.id}', ${grievanceData})">${remarkButtonText}</button>
                    <!-- Delete button retained for permanent deletion (Super Admin function) -->
                    <button class="btn btn-danger btn-delete-sm" data-id="${g.id}" onclick="deleteGrievance('${g.id}')">Delete Record</button>
                </td>
            `;
        });
        
    } catch (e) {
        console.error("Error loading grievances:", e);
        // Ensure the error display uses the correct colspan (7)
        tableBody.innerHTML = `<tr><td colspan="7" class="text-center error">Failed to load grievances. Check console for details.</td></tr>`;
    }
}

/**
 * Super Admin function to update the grievance status and add remarks.
 */
async function updateGrievanceRemark(e) {
    e.preventDefault();
    
    // Log start of update
    console.log("Attempting to update grievance remark and status...");
    
    const id = document.getElementById('grievance-id').value;
    const remark = document.getElementById('grievance-remark').value.trim();
    const newStatus = document.getElementById('grievance-new-status').value;

    if (!remark || remark.length < 10) {
        showToast('Remark is required and should be descriptive (Min 10 characters).', true);
        return;
    }

    try {
        const { error } = await Supabase
            .from('grievances')
            .update({ 
                superadmin_remark: remark, 
                status: newStatus,
                last_updated: new Date().toISOString()
            })
            .eq('id', id);

        if (error) {
            console.error("Supabase update error:", error);
            throw error;
        }
        
        // LOG ACTIVITY
        await logActivity('UPDATE_GRIEVANCE', { grievance_id: id, status: newStatus, remark_length: remark.length });

        showToast(`Grievance updated to ${newStatus} successfully!`, false);
        
        // Hide modal and refresh data
        document.getElementById('grievance-remark-modal').style.display = 'none';
        loadGrievanceSection(); 
    } catch (e) {
        console.error("Grievance update failed in try/catch block:", e);
        showToast(`Failed to update grievance: ${e.message}`, true);
    }
}

/**
 * Opens the modal for the Super Admin to add/edit remarks.
 */
window.openGrievanceRemarkModal = (id, data) => {
    const modal = document.getElementById('grievance-remark-modal');
    if (!modal) return;
    
    document.getElementById('grievance-id').value = id;
    document.getElementById('grievance-uid-display').textContent = data.uid;
    document.getElementById('grievance-message-display').textContent = data.message;
    document.getElementById('grievance-remark').value = data.remark;
    document.getElementById('grievance-new-status').value = data.status;

    modal.style.display = 'block';
};


/**
 * FIX: Removed window.confirm. Button click is the confirmation.
 */
async function deleteGrievance(grievanceId) {
    if (userRole !== 'super_admin') {
        showToast('Permission Denied: Only Super Admin can delete grievances.', true);
        return;
    }
    
    // FIX: Removed window.confirm. The button click is now the confirmation.
    showToast('Marking grievance as reviewed and deleting...', false);

    try {
        const { error } = await Supabase
            .from('grievances')
            .delete()
            .eq('id', grievanceId);

        if (error) throw error;

        showToast('Grievance marked as reviewed and deleted.', false);
        loadGrievanceSection();
    } catch (e) {
        console.error("Error deleting grievance:", e);
        showToast(`Failed to delete grievance: ${e.message}`, true);
    }
}


// --- 8. SUPER ADMIN DASHBOARD LOGIC (superadmin_dashboard.html) ---

/**
 * Searches and filters all violation records for Super Admin.
 * FIX: Renamed profile relationship alias from `profiles!tc_id` to `tc_profile` for clarity.
 */
async function searchSuperAdminViolations(searchTerm = '', statusFilter = 'all') {
    
    const historyBody = document.getElementById('history-table-body');
    historyBody.innerHTML = '<tr><td colspan="7" class="text-center">Searching all records...</td></tr>';
    
    let query = Supabase
        .from('violations')
        .select(`
            id,
            created_at,
            fine_amount,
            status,
            location,
            receipt_uid,
            transaction_uid,
            tc_id,
            rules (name),
            tc_profile:profiles!tc_id (employee_id, full_name),
            passengers (name, aadhaar_number, mobile)
        `)
        .order('created_at', { ascending: false });
        // NEW LOGIC: If no search term and status is 'all', limit to 5 for the initial dashboard view
    if (!searchTerm && statusFilter === 'all') {
        query = query.limit(5);
    } else {
        // Otherwise, allow a larger set (e.g., 50) for filtered search results
        query = query.limit(50);
    }   
    // 1. Filter by Status (DB side filtering)
    if (statusFilter !== 'all') {
        query = query.eq('status', statusFilter);
    }
    
    const { data: violations, error: vError } = await query;
    
    if (vError) {
        console.error('Error fetching Super Admin violations:', vError);
        historyBody.innerHTML = `<tr><td colspan="7" class="text-center error">Error loading records. Check console for RLS policy issues.</td></tr>`;
        return;
    }

    let filteredViolations = violations || [];
    
    // 2. Client-side Search Term Refinement 
    if (searchTerm) {
        const lowerSearchTerm = searchTerm.toLowerCase();
        filteredViolations = violations.filter(v => 
            v.passengers?.name?.toLowerCase().includes(lowerSearchTerm) ||
            v.passengers?.aadhaar_number?.includes(lowerSearchTerm) ||
            v.location?.toLowerCase().includes(lowerSearchTerm) ||
            v.receipt_uid?.toLowerCase().includes(lowerSearchTerm)
        );
    }
    
    // 3. Display Results (Limited to latest 50 for performance if filtering large dataset)
    historyBody.innerHTML = '';
    
    if (filteredViolations.length === 0) {
         historyBody.innerHTML = `<tr><td colspan="7" class="text-center empty-state">No records matched your search/filter criteria.</td></tr>`;
         return;
    }


    filteredViolations.slice(0, 50).forEach(v => {
        const statusColor = v.status === 'paid' ? 'var(--color-success)' : 'var(--color-danger)';
        const passengerName = v.passengers?.name || 'N/A';
        
        // Prepare the violation data for actions (deletion/editing/collecting)
        const violationData = {
            id: v.id,
            receipt_uid: v.receipt_uid,
            fine_amount: v.fine_amount,
            status: v.status
        };
        
        const collectButton = v.status === 'unpaid' 
            // Pass the passenger name for the payment page summary
            ? `<button class="btn btn-success btn-edit-sm" onclick="processFinePaymentForStaff('${v.id}', ${v.fine_amount}, '${passengerName}')">Collect</button>`
            : '';


        const row = historyBody.insertRow();
        // FIX: Accessing aliased column name `tc_profile`
        row.innerHTML = `
            <td>${formatDate(v.created_at)}</td>
            <td>${passengerName} <br><small style="color: var(--color-text-light);">Ref: ${v.receipt_uid}</small></td>
            <td>${v.rules?.name || 'N/A'}</td>
            <td>${formatCurrency(v.fine_amount)}</td>
            <td style="color: ${statusColor}; font-weight: 600;">${v.status.toUpperCase()}</td>
            <td>${v.tc_profile?.employee_id || 'N/A'}</td>
            <td>
                <!-- Edit is currently a placeholder -->
                <button class="btn btn-info btn-edit-sm" onclick="openViolationEditModal(${JSON.stringify(violationData).replace(/"/g, '&quot;')})">Edit</button>
                <button class="btn btn-danger btn-delete-violation-sm" data-id="${v.id}" data-receipt="${v.receipt_uid}">Delete</button>
                ${collectButton}
            </td>
        `;
    });
    
    // Attach listener for deletion after loading all rows
    historyBody.querySelectorAll('.btn-delete-violation-sm').forEach(btn => {
        btn.addEventListener('click', () => deleteViolation(btn.dataset.id, btn.dataset.receipt));
    });
}


async function loadSuperAdminDashboard() {
    const isAuthenticated = await protectPage();
    if (!isAuthenticated || userRole !== 'super_admin') return;

    try {
        // --- 1. Fetch System Stats ---
        // FIX: Renamed profile relationship alias from `profiles!tc_id` to `tc_profile` for clarity.
        const { data: allViolations, error: vError } = await Supabase
            .from('violations')
            .select(`
                id, 
                created_at,
                fine_amount, 
                status, 
                passenger_id, 
                receipt_uid, 
                location,
                rules (name), 
                tc_profile:profiles!tc_id (employee_id, full_name),
                passengers (name, aadhaar_number)
            `); // Fetch data required for stats and pending fines list

        if (vError) throw vError;

        let totalRecorded = 0;
        let totalCollected = 0;
        let totalPending = 0;
        const passengerViolationCounts = {};

        allViolations.forEach(v => {
            totalRecorded += v.fine_amount;
            if (v.status === 'paid') {
                totalCollected += v.fine_amount;
            } else {
                totalPending += v.fine_amount;
            }
            passengerViolationCounts[v.passenger_id] = (passengerViolationCounts[v.passenger_id] || 0) + 1;
        });
        
        // Calculate Repeat Offenders (Those with > 1 violation)
        let repeatCount = 0;
        for (const count of Object.values(passengerViolationCounts)) {
            if (count > 1) {
                repeatCount++;
            }
        }
        
        const { count: managerCount, error: mError } = await Supabase
            .from('profiles')
            .select('*', { count: 'exact', head: true })
            .eq('role_id', 2); // Role ID 2 = station_manager

        const { count: tcCount, error: tceError } = await Supabase
            .from('profiles')
            .select('*', { count: 'exact', head: true })
            .eq('role_id', 3); // Role ID 3 = tc

        if (mError || tceError) { console.error("Error fetching user counts:", mError || tceError); }


        const collectionRate = totalRecorded > 0 ? ((totalCollected / totalRecorded) * 100).toFixed(1) : 0;

        // --- 2. Update Dashboard Stats ---
        document.getElementById('stat-total-recorded').textContent = formatCurrency(totalRecorded);
        document.getElementById('stat-total-collected').textContent = formatCurrency(totalCollected);
        document.getElementById('stat-collection-rate').textContent = `${collectionRate}%`;
        document.getElementById('stat-managers').textContent = managerCount || 0;
        document.getElementById('stat-ttes').textContent = tcCount || 0;
        document.getElementById('stat-repeat-offenders').textContent = repeatCount;
        
        document.getElementById('stat-pending-fines').textContent = formatCurrency(totalPending);
        document.getElementById('stat-total-collected-history').textContent = formatCurrency(totalCollected);
        document.getElementById('stat-total-violations').textContent = allViolations.length;


        // --- 3. Load Management and History Sections ---
        loadStaffManagementSection();
        loadRulesManagementSection();
        
        // Populate the PENDING FINES list using the fetched data (allViolations)
        const pendingBody = document.getElementById('pending-fines-table-body');
        const pendingFines = allViolations
            .filter(v => v.status === 'unpaid')
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
            .slice(0, 10);
            
        pendingBody.innerHTML = pendingFines.length === 0 ? '<tr><td colspan="7" class="text-center">No pending fines found.</td></tr>' : '';
        
        pendingFines.forEach(v => {
             const row = pendingBody.insertRow();
             const passengerName = v.passengers?.name || 'N/A';
             // FIX: Accessing aliased column name `tc_profile`
             row.innerHTML = `
                 <td>${formatDate(v.created_at)}</td>
                 <td>${passengerName}</td>
                 <td>${v.passengers?.aadhaar_number || 'N/A'}</td>
                 <td>${formatCurrency(v.fine_amount)}</td>
                 <td>${v.tc_profile?.employee_id || 'N/A'}</td>
                 <td>${v.location || 'N/A'}</td>
                 <td>
                    <button class="btn btn-success btn-edit-sm" onclick="processFinePaymentForStaff('${v.id}', ${v.fine_amount}, '${passengerName}')">Collect</button>
                 </td>
             `;
        });
        
        // Load Grievance Section
        loadGrievanceSection();

        // Run an initial search to populate the History table
        searchSuperAdminViolations(); 

    } catch (e) {
        console.error("Error loading Super Admin dashboard stats:", e);
        showToast("Error loading dashboard data.", true);
    }
}

/**
 * FIX: RLS Error: This function is completely refactored to perform a safe two-step lookup 
 * instead of relying on the problematic self-referencing foreign key join (profiles!higher_officer_id).
 */
async function loadStaffManagementSection() {
    const tableBody = document.getElementById('staff-table-body');
    tableBody.innerHTML = '<tr><td colspan="6" class="text-center">Loading staff records...</td></tr>';
    const roleSelect = document.getElementById('staff-role');
    const stationNameInput = document.getElementById('staff-station-name');

    // Populate roles dropdown (unchanged)
    roleSelect.innerHTML = '';
    const managerId = 2;
    const option = document.createElement('option');
    option.value = managerId;
    option.textContent = STAFF_ROLES[managerId];
    roleSelect.appendChild(option);
    roleSelect.value = managerId;
    roleSelect.disabled = true;

    stationNameInput.disabled = false;
    stationNameInput.required = true;
    
    // Setup Create Staff Form submission (unchanged)
    const form = document.getElementById('create-staff-form');
    if (form && !hasStaffFormListener) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('staff-email').value.trim();
            const password = document.getElementById('staff-password').value;
            const roleId = parseInt(document.getElementById('staff-role').value);
            const employeeId = document.getElementById('staff-employee-id').value.trim();
            const fullName = document.getElementById('staff-full-name').value.trim();
            const age = parseInt(document.getElementById('staff-age').value);
            const mobileNumber = document.getElementById('staff-mobile-number').value.trim();
            const stationName = document.getElementById('staff-station-name').value.trim();

            const { error } = await createStaffUser(email, password, roleId, employeeId, fullName, age, mobileNumber, stationName);
            if (!error) {
                form.reset();
                loadStaffManagementSection();
            }
        });
        hasStaffFormListener = true;
    }


    // --- LOAD STAFF LIST (Two-Step Lookup) ---
     try {
        // Step 1: Fetch all staff profiles and their higher_officer_id
        const { data: staff, error } = await Supabase
            .from('profiles')
            .select(`id, email, employee_id, full_name, station_name, role_id, mobile_number, higher_officer_id, age`)
            .or('role_id.eq.2,role_id.eq.3')
            .order('role_id', { ascending: true }); // Managers first, then TTEs

        if (error) throw error;
        
        const staffList = staff || [];
        const higherOfficerIds = new Set(staffList.map(s => s.higher_officer_id).filter(id => id && id !== currentUserId));
        
        const officerMap = {};
        
        // Add current Super Admin manually (since they are the higher officer for Managers)
        officerMap[currentUserId] = 'Super Admin (You)'; 

        if (higherOfficerIds.size > 0) {
            // Step 2: Fetch the full_name for all unique higher officers
            const { data: officersData, error: officerError } = await Supabase
                .from('profiles')
                .select('id, full_name')
                .in('id', Array.from(higherOfficerIds));

            if (officerError) throw officerError;
            
            (officersData || []).forEach(o => {
                officerMap[o.id] = o.full_name;
            });
        }
        
        tableBody.innerHTML = '';

        staffList.forEach(s => {
            const row = tableBody.insertRow();
            const roleName = STAFF_ROLES[s.role_id] || 'N/A';
            const email = s.email || 'N/A'; 
            const station = s.station_name || 'N/A';
            const sId = s.id; 
            const higherOfficerName = officerMap[s.higher_officer_id] || 'N/A'; // Use the resolved name

            // Prepare staff data for modal
            const staffData = JSON.stringify({
                id: sId, 
                full_name: s.full_name, 
                email: email, 
                role: roleName, 
                station_name: station, 
                employee_id: s.employee_id,
                age: s.age,
                mobile_number: s.mobile_number
            });
            
            const actions = 
                `<button class="btn btn-info btn-edit-sm" 
                         onclick="openSuperAdminStaffEditModal(${staffData.replace(/"/g, '&quot;')})">Edit</button>
                 <button class="btn btn-danger btn-delete-sm" onclick="deleteStaffUser('${sId}', '${roleName}')">Delete</button>`;

            row.innerHTML = `
                <td>${roleName.toUpperCase()}</td>
                <td>${station}</td>
                <td>${s.full_name || 'N/A'} <br><small>H/O: ${higherOfficerName}</small></td>
                <td>${s.employee_id || 'N/A'}</td>
                <td>${email}</td>
                <td>${actions}</td>
            `;
        });
        
        if (staffList.length === 0) {
             tableBody.innerHTML = '<tr><td colspan="6" class="text-center">No staff users found.</td></tr>';
        }

    } catch (e) {
        console.error("Error loading staff users:", e);
        // Display the specific PostgREST error message for better debugging
        let errorMessage = `Failed to load staff data. DB Error: ${e.message}. If the error mentions 'profiles' and 'profiles', check foreign key constraint setup for 'higher_officer_id'.`;
        tableBody.innerHTML = `<tr><td colspan="6" class="text-center error">${errorMessage}</td></tr>`;
    }
}

async function loadRulesManagementSection() {
     // Setup Create Rule Form submission
    const form = document.getElementById('add-rule-form');
    if (form && !hasRuleFormListener) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const name = document.getElementById('new-rule-name').value.trim();
            const baseFine = parseFloat(document.getElementById('new-rule-fine').value);
            
            try {
                if (baseFine < 10) {
                     showToast('Base fine must be at least ₹10.', true);
                     return;
                }
                
                const { error } = await Supabase.from('rules').insert([{ name, base_fine: baseFine, is_active: true }]);
                if (error) throw error;
                
                await logActivity('CREATE_RULE', { rule_name: name, base_fine: baseFine }); // LOG ACTIVITY

                showToast(`New rule '${name}' added!`, false);
                form.reset();
                loadRulesManagementSection(); // Refresh list
            } catch (e) {
                showToast(`Failed to add rule: ${e.message}`, true);
            }
        });
        hasRuleFormListener = true;
    }
    
    const tableBody = document.getElementById('rules-table-body');
    tableBody.innerHTML = '<tr><td colspan="4" class="text-center">Loading rules...</td></tr>';

    // Load Rules List
    try {
        const { data: rules, error } = await Supabase.from('rules').select('*').order('base_fine', { ascending: false });
        if (error) throw error;
        
        tableBody.innerHTML = '';
        (rules || []).forEach(rule => {
            const statusText = rule.is_active ? 'Active' : 'Inactive';
            const row = tableBody.insertRow();
            row.innerHTML = `
                <td>${rule.name}</td>
                <td>${formatCurrency(rule.base_fine)}</td>
                <td>${statusText}</td>
                <td>
                    <button class="btn btn-primary btn-edit-sm" 
                            onclick="openRuleFineEditModal('${rule.id}', '${rule.name}', ${rule.base_fine})">Edit Fine</button>
                    <button class="btn btn-danger btn-delete-rule-sm" 
                            onclick="deleteRule('${rule.id}', '${rule.name}')">Delete</button>
                </td>
            `;
        });
        
        if (rules.length === 0) {
             tableBody.innerHTML = `<tr><td colspan="4" class="text-center">No rules defined yet.</td></tr>`;
        }

    } catch (e) {
        tableBody.innerHTML = `<tr><td colspan="4" class="text-center error">Failed to load rules.</td></tr>`;
    }
}


// --- 9. ADMIN (STATION MANAGER): DASHBOARD LOGIC (admin_dashboard.html) ---

// FIX 2: loadAdminDashboard must be defined globally via declaration
async function loadAdminDashboard() {
    const isAuthenticated = await protectPage();
    if (!isAuthenticated || userRole !== 'station_manager') return;

    const adminId = currentUserId;
    if (!adminId) return;

    // Fetch the manager's profile to get their station name
    const { data: managerProfile, error: profileError } = await Supabase
        .from('profiles')
        .select('full_name, station_name')
        .eq('id', adminId)
        .single();
        
    if (profileError || !managerProfile) {
        console.error("Error fetching manager profile:", profileError);
        showToast("Error loading manager details.", true);
        return;
    }
    
    console.log(`Loading Admin Dashboard for ${managerProfile.full_name} at ${managerProfile.station_name}`);


    const tcTableBody = document.getElementById('tc-performance-body');
    const passengerListBody = document.getElementById('admin-passenger-list');
    tcTableBody.innerHTML = '<tr><td colspan="5" class="text-center">Loading TC data...</td></tr>';
    passengerListBody.innerHTML = '<tr><td colspan="6" class="text-center">Loading violation records...</td></tr>'; // Updated colspan
    
    // FIX 2: The call to loadTTEManagementSection should now resolve correctly
    await loadTTEManagementSection(adminId);

    try {
        // 1. Fetch TTEs assigned to this manager
        const { data: assignedTtesData, error: tteError } = await Supabase
            .from('ttes')
            .select('id') 
            .eq('manager_id', adminId);

        if (tteError) throw tteError;

        const assignedTcIds = (assignedTtesData || []).map(tc => tc.id);
        
        if (assignedTcIds.length === 0) {
            document.getElementById('admin-total-recorded').textContent = formatCurrency(0);
            document.getElementById('admin-total-collected').textContent = formatCurrency(0);
            document.getElementById('admin-violations-today').textContent = 0; // NEW STAT CARD
            document.getElementById('admin-collection-rate').textContent = `0%`;
            tcTableBody.innerHTML = `<tr><td colspan="5" class="text-center">No TTEs are currently assigned to your station.</td></tr>`;
            passengerListBody.innerHTML = `<tr><td colspan="6" class="text-center">No TTEs assigned. No records to show.</td></tr>`;
            return;
        }

        // 2. Fetch TTE Profiles for display
        const { data: tteProfiles, error: tteProfileError } = await Supabase
            .from('profiles')
            .select('id, full_name, employee_id, station_name') 
            .in('id', assignedTcIds);
            
        if (tteProfileError) throw tteProfileError;
        
        const tteProfileMap = tteProfiles.reduce((map, profile) => {
             map[profile.id] = profile;
             return map;
        }, {});


        // 3. Fetch all violations logged ONLY by those assigned TCs
        const { data: violations, error: violationError } = await Supabase
            .from('violations')
            .select(`
                id,
                fine_amount,
                status,
                tc_id,
                created_at,
                passengers (name, aadhaar_number),
                tc_profile:profiles!tc_id (employee_id)
            `)
            .in('tc_id', assignedTcIds);

        if (violationError) throw violationError;

        // --- Aggregation ---
        let totalRecorded = 0;
        let totalCollected = 0;
        let violationsTodayCount = 0; // NEW: Violations Today counter
        
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayStartISO = todayStart.toISOString();

        const tcPerformance = {};

        // Initialize performance tracker for all assigned TTEs
        assignedTcIds.forEach(id => {
            const profile = tteProfileMap[id];
            if (profile) {
                tcPerformance[id] = { name: profile.full_name, employee_id: profile.employee_id, recorded: 0, collected: 0, latestViolations: [] };
            }
        });

        // Populate performance data from violations
        (violations || []).forEach(v => {
            totalRecorded += v.fine_amount;
            if (v.status === 'paid') {
                totalCollected += v.fine_amount;
            }
            
            // NEW: Violations Today calculation
            if (v.created_at && v.created_at >= todayStartISO) {
                violationsTodayCount++;
            }

            if (tcPerformance[v.tc_id]) {
                tcPerformance[v.tc_id].recorded += v.fine_amount;
                if (v.status === 'paid') {
                    tcPerformance[v.tc_id].collected += v.fine_amount;
                }
            }
        });
        
        const latestViolations = (violations || [])
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
            .slice(0, 10);

        // --- Display Stats ---
        document.getElementById('admin-total-recorded').textContent = formatCurrency(totalRecorded);
        document.getElementById('admin-total-collected').textContent = formatCurrency(totalCollected);
        document.getElementById('admin-violations-today').textContent = violationsTodayCount; // NEW STAT CARD
        document.getElementById('admin-collection-rate').textContent = `${totalRecorded > 0 ? ((totalCollected / totalRecorded) * 100).toFixed(1) : 0}%`;

        // --- Display TC Performance ---
        tcTableBody.innerHTML = '';
        Object.values(tcPerformance).sort((a, b) => b.collected - a.collected).forEach(tc => {
            const row = tcTableBody.insertRow();
            row.innerHTML = `
                <td>${tc.name}</td>
                <td>${tc.employee_id}</td>
                <td>${formatCurrency(tc.recorded)}</td>
                <td>${formatCurrency(tc.collected)}</td>
                <td>${tc.recorded > 0 ? ((tc.collected / tc.recorded) * 100).toFixed(1) : 0}%</td>
            `;
        });
        
        // Store mapped profiles globally for use in report generation
        window.tteProfileMap = tteProfileMap;


        // --- Display Violation Records ---
        passengerListBody.innerHTML = '';
        if (latestViolations.length > 0) {
            latestViolations.forEach(v => {
                const statusColor = v.status === 'paid' ? 'var(--color-success)' : 'var(--color-danger)';
                const passengerName = v.passengers?.name || 'N/A';
                const row = passengerListBody.insertRow();
                
                let payButton = '';
                if (v.status === 'unpaid') {
                    payButton = `<button class="btn btn-success btn-edit-sm" onclick="processFinePaymentForStaff('${v.id}', ${v.fine_amount}, '${passengerName}')">Collect</button>`;
                }
                
                // FIX: Accessing aliased column name `tc_profile`
                row.innerHTML = `
                    <td>${passengerName}</td>
                    <td>${v.passengers?.aadhaar_number || 'N/A'}</td>
                    <td>${formatCurrency(v.fine_amount)}</td>
                    <td><span style="color: ${statusColor}; font-weight: 600;">${v.status.toUpperCase()}</span></td>
                    <td>${v.tc_profile?.employee_id || 'N/A'}</td>
                    <td>${payButton}</td>
                `;
            });
        } else {
             passengerListBody.innerHTML = `<tr><td colspan="6" class="text-center">No violation records found for your TTEs.</td></tr>`; // Updated colspan
        }
        


    } catch (e) {
        console.error("Error loading Admin Analytics:", e);
        showToast(`Failed to load Admin Analytics: ${e.message}`, true);
    }
}


// --- CRITICAL FIX: TTE PERFORMANCE REPORT GENERATOR (MISSING FUNCTION) ---
/**
 * CRITICAL FIX: Generates the TTE performance report based on the date range selected by the Station Manager.
 */
async function generateTCReport(e) {
    e.preventDefault();
    
    const adminId = currentUserId; // Should be the manager's ID
    if (!adminId) return;

    const startDate = document.getElementById('report-start-date').value;
    const endDate = document.getElementById('report-end-date').value;
    const reportOutputDiv = document.getElementById('tc-report-output');
    const reportBody = document.getElementById('tc-report-table-body');
    const reportSummary = document.getElementById('report-summary');
    const reportTitleDate = document.getElementById('report-title-date');

    if (!startDate || !endDate) {
        showToast('Please select both a Start Date and an End Date.', true);
        return;
    }

    reportOutputDiv.style.display = 'block';
    reportBody.innerHTML = '<tr><td colspan="5" class="text-center">Generating report...</td></tr>';
    reportSummary.textContent = 'Calculating totals...';
    reportSummary.className = 'empty-state';
    
    // Convert dates to ISO strings for Supabase range query (assuming UTC midnight)
    const startISO = new Date(startDate + 'T00:00:00.000Z').toISOString();
    const endISO = new Date(endDate + 'T23:59:59.999Z').toISOString();
    
    // Use the already fetched TTE ID list from loadAdminDashboard (stored in window.tteProfileMap)
    const assignedTcIds = Object.keys(window.tteProfileMap || {});
    
    if (assignedTcIds.length === 0) {
        reportBody.innerHTML = '<tr><td colspan="5" class="text-center empty-state">No TTEs are assigned to your station.</td></tr>';
        reportSummary.textContent = 'Report failed: No assigned TTEs.';
        reportSummary.className = 'empty-state error';
        return;
    }
    
    try {
        // 1. Fetch relevant violations
        const { data: violations, error } = await Supabase
            .from('violations')
            .select(`fine_amount, status, tc_id`)
            .in('tc_id', assignedTcIds)
            .gte('created_at', startISO)
            .lte('created_at', endISO);
            
        if (error) throw error;
        
        // 2. Initialize and Aggregate Performance Data
        const reportData = {};
        let grandTotalRecorded = 0;
        let grandTotalCollected = 0;

        assignedTcIds.forEach(id => {
            const profile = window.tteProfileMap[id];
            reportData[id] = { 
                name: profile.full_name, 
                employee_id: profile.employee_id, 
                recorded: 0, 
                collected: 0,
                violation_count: 0
            };
        });

        (violations || []).forEach(v => {
            if (reportData[v.tc_id]) {
                reportData[v.tc_id].recorded += v.fine_amount;
                reportData[v.tc_id].violation_count += 1;
                grandTotalRecorded += v.fine_amount;
                
                if (v.status === 'paid') {
                    reportData[v.tc_id].collected += v.fine_amount;
                    grandTotalCollected += v.fine_amount;
                }
            }
        });
        
        // 3. Display Results
        reportBody.innerHTML = '';
        let totalRecords = 0;

        Object.values(reportData).sort((a, b) => b.recorded - a.recorded).forEach(data => {
            const collectionRate = data.recorded > 0 ? ((data.collected / data.recorded) * 100).toFixed(1) : '0.0';
            const row = reportBody.insertRow();
            totalRecords += data.violation_count;
            row.innerHTML = `
                <td>${data.name}</td>
                <td>${data.violation_count}</td>
                <td>${formatCurrency(data.recorded)}</td>
                <td>${formatCurrency(data.collected)}</td>
                <td>${collectionRate}%</td>
            `;
        });
        
        // Final Summary
        const grandCollectionRate = grandTotalRecorded > 0 ? ((grandTotalCollected / grandTotalRecorded) * 100).toFixed(1) : '0.0';
        reportTitleDate.textContent = `${startDate} to ${endDate}`;
        reportSummary.innerHTML = `
            <strong>Report Summary (${totalRecords} Violations):</strong> 
            Total Recorded: ${formatCurrency(grandTotalRecorded)} | 
            Total Collected: ${formatCurrency(grandTotalCollected)} | 
            Grand Collection Rate: **${grandCollectionRate}%**
        `;
        reportSummary.className = 'empty-state success'; // Use success state for positive outcome

    } catch (e) {
        console.error("Error generating TC Report:", e);
        reportBody.innerHTML = '<tr><td colspan="5" class="text-center empty-state error">Report generation failed due to a database error.</td></tr>';
        reportSummary.textContent = `Report failed: ${e.message}`;
        reportSummary.className = 'empty-state error';
    }
}


// --- TTE MANAGEMENT SECTION (STATION MANAGER) ---

// FIX 1: createTTEAccount must be defined globally via declaration
async function createTTEAccount(e) {
    e.preventDefault();
    
    if (userRole !== 'station_manager') {
         showToast('Permission Denied. Only Station Managers can create TTEs.', true);
         return;
    }

    const name = document.getElementById('tte-full-name').value.trim();
    const age = parseInt(document.getElementById('tte-age').value);
    const employeeId = document.getElementById('tte-employee-id').value.trim();
    const mobileNumber = document.getElementById('tte-mobile-number').value.trim();
    const email = document.getElementById('tte-email').value.trim();
    const password = document.getElementById('tte-password').value;

    // Note: Station Name is null for TTEs, but the profile gets the manager's station during assignment.
    // currentUserId will be the higher_officer_id (Station Manager's ID)
    const { error } = await createStaffUser(email, password, 3, employeeId, name, age, mobileNumber, null); // Role 3 = TTE

    if (error) {
        showToast(`Failed to create TTE: ${error.message}`, true);
    } else {
        document.getElementById('create-tte-form').reset();
        loadAdminDashboard(); // Refresh the entire dashboard including TTE list
    }
}

// FIX 2: loadTTEManagementSection must be defined globally via declaration
async function loadTTEManagementSection(managerId) {
    const manageTTEBody = document.getElementById('manage-tte-body');
    manageTTEBody.innerHTML = '<tr><td colspan="4" class="text-center">Loading TTE data...</td></tr>';
    
    try {
        const { data: assignments, error: assignmentError } = await Supabase
            .from('ttes')
            .select('id')
            .eq('manager_id', managerId);
            
        if (assignmentError) throw assignmentError;

        const tteIds = (assignments || []).map(a => a.id);
        
        const { data: tteProfiles, error: profileError } = await Supabase
             .from('profiles')
             .select('id, full_name, employee_id, mobile_number, age')
             .in('id', tteIds);

        if (profileError) throw profileError;

        manageTTEBody.innerHTML = '';
        if (tteProfiles.length === 0) {
            manageTTEBody.innerHTML = `<tr><td colspan="4" class="empty-state text-center">No TTEs assigned to your group yet.</td></tr>`;
            return;
        }

        (tteProfiles || []).forEach(tte => {
            const row = manageTTEBody.insertRow();
            // Data needed for the modal
            const tteData = JSON.stringify({
                id: tte.id,
                name: tte.full_name,
                age: tte.age || 0,
                mobile: tte.mobile_number,
                empId: tte.employee_id
            }).replace(/"/g, '&quot;');
            
            row.innerHTML = `
                <td>${tte.full_name || 'N/A'}</td>
                <td>${tte.employee_id || 'N/A'}</td>
                <td>${tte.mobile_number || 'N/A'}</td>
                <td>
                    <button class="btn btn-info btn-edit-sm" onclick="openUpdateModal('${tte.id}', '${tte.full_name}', ${tte.age || 0}, '${tte.mobile_number}', '${tte.employee_id}')">Update Profile</button>
                </td>
            `;
        });

    } catch (e) {
        console.error("Error loading TTEs for management:", e);
        manageTTEBody.innerHTML = `<tr><td colspan="4" class="text-center error">Failed to load TTE list.</td></tr>`;
    }
}

// Global modal functions for Admin Dashboard
window.openUpdateModal = (tteId, name, age, mobile, empId) => {
    const modal = document.getElementById('tte-update-modal');
    
    document.getElementById('update-tte-id').value = tteId;
    document.getElementById('update-tte-name').value = name;
    document.getElementById('update-tte-age').value = age;
    document.getElementById('update-tte-mobile').value = mobile;
    document.getElementById('update-tte-employee-id').value = empId;
    modal.style.display = 'block';
}

async function updateTTEProfile(e) {
    e.preventDefault();
    
    const tteId = document.getElementById('update-tte-id').value;
    const fullName = document.getElementById('update-tte-name').value.trim();
    const age = parseInt(document.getElementById('update-tte-age').value);
    const mobileNumber = document.getElementById('update-tte-mobile').value.trim();
    const employeeId = document.getElementById('update-tte-employee-id').value.trim();

    try {
        const { error } = await Supabase
            .from('profiles')
            .update({
                full_name: fullName,
                age: age,
                mobile_number: mobileNumber,
                employee_id: employeeId
            })
            .eq('id', tteId);

        if (error) throw error;
        
        showToast(`Profile for ${fullName} updated successfully!`, false);
        document.getElementById('tte-update-modal').style.display = 'none';
        loadAdminDashboard(); 
    } catch (e) {
        showToast(`Failed to update profile: ${e.message}`, true);
    }
}

// --- 10. TTE DASHBOARD LOGIC (tte_dashboard.html) ---

async function loadTteDashboard() {
    const isAuthenticated = await protectPage();
    if (!isAuthenticated || userRole !== 'tc') return;

    const tteId = currentUserId;
    if (!tteId) return;
    
    const tableBody = document.getElementById('tte-recent-violations-body');
    tableBody.innerHTML = '<tr><td colspan="5" class="text-center">Loading your recent activity...</td></tr>';
    
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Fetch TTE's violations and profile info
        const { data: violations, error: vError } = await Supabase
            .from('violations')
            .select(`
                created_at,
                fine_amount,
                status,
                location,
                passengers (name)
            `)
            .eq('tc_id', tteId)
            .order('created_at', { ascending: false });

        if (vError) throw vError;

        let violationsToday = 0;
        let collectedToday = 0;
        let totalOutstandingSelf = 0;
        const recentViolations = (violations || []).slice(0, 5);


        // NEW LOGIC: Calculate total of all UNPAID fines issued by this TTE
        const { data: issuedUnpaidFines, error: issuedError } = await Supabase
        .from('violations')
        .select('fine_amount')
        .eq('tc_id', tteId)
        .eq('status', 'unpaid');

        if (!issuedError && issuedUnpaidFines) {
        totalOutstandingSelf = issuedUnpaidFines.reduce((sum, v) => sum + v.fine_amount, 0);
        } else if (issuedError) {
        console.error("Error fetching issued unpaid fines:", issuedError);
        }

        (violations || []).forEach(v => {
            if (new Date(v.created_at) >= today) {
                violationsToday++;
            }
            if (v.status === 'paid' && new Date(v.created_at) >= today) {
                 collectedToday += v.fine_amount;
            }
        });

        // 3. Update Dashboard Stats
        document.getElementById('stat-violations-today').textContent = violationsToday;
        document.getElementById('stat-collected-today').textContent = formatCurrency(collectedToday);
        document.getElementById('stat-my-outstanding').textContent = formatCurrency(totalOutstandingSelf);

        // 4. Update Recent Violations Table
        tableBody.innerHTML = '';

        if (recentViolations.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="5" class="text-center">No violations logged by you yet.</td></tr>`;
        } else {
            recentViolations.forEach(v => {
                const row = tableBody.insertRow();
                const fineColor = v.status === 'paid' ? 'var(--color-success)' : 'var(--color-danger)';
                row.innerHTML = `
                    <td>${formatDate(v.created_at)}</td>
                    <td>${v.passengers?.name || 'N/A'}</td>
                    <td style="font-weight: 600;">${formatCurrency(v.fine_amount)}</td>
                    <td style="color: ${fineColor}; font-weight: 600;">${v.status.toUpperCase()}</td>
                    <td>${v.location || 'N/A'}</td>
                `;
            });
        }
        
        // If the main search area is displaying the initial prompt, reset it if necessary
        const searchResultsTable = document.getElementById('tte-results-table');
        const initialSearchPrompt = document.getElementById('initial-search-prompt');
        
        // Ensure that on load, the results table is hidden unless a search is run
        if (searchResultsTable) {
            searchResultsTable.style.display = 'none';
        }
        if (initialSearchPrompt) {
            initialSearchPrompt.style.display = 'block';
        }


    } catch (e) {
        console.error("Error loading TTE dashboard stats:", e);
        showToast("Error loading TTE dashboard data.", true);
    }
}


// --- 14. GLOBAL EVENT HANDLERS ---

document.addEventListener('DOMContentLoaded', () => {
    const currentPageName = window.location.pathname.split('/').pop();

    // 1. Run protectPage first, which is an async operation that sets userRole.
    // The role-specific initialization functions are now wrapped in an async IIFE
    // or called after a brief timeout to ensure userRole is available.
    
    // We run this async function immediately.
    (async () => {
        await protectPage();

        // 2. Setup general listeners that don't depend on page roles
        const loginForm = document.getElementById('login-form');
        if (loginForm) { 
            loginForm.addEventListener('submit', (e) => { 
                e.preventDefault(); 
                loginUser(); 
            }); 
        }

        const logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn) { logoutBtn.addEventListener('click', logout); }

        const navToggle = document.querySelector('.nav-toggle');
        const navLinks = document.querySelector('.nav-links');
        if (navToggle) {
            navToggle.addEventListener('click', () => {
                navLinks.classList.toggle('active');
            });
        }
        
// Toggle Rules Visibility Logic
        const toggleRulesBtn = document.getElementById('toggle-rules-btn');
        const rulesWrapper = document.getElementById('rules-table-wrapper');

        if (toggleRulesBtn && rulesWrapper) {
            toggleRulesBtn.addEventListener('click', () => {
                 if (rulesWrapper.style.display === 'none') {
                    rulesWrapper.style.display = 'block';
                    toggleRulesBtn.textContent = 'Hide Rules and Fines';
                    // Optional: Reload the rules to ensure they are fresh
                    loadRulesManagementSection(); 
                } else {
                    rulesWrapper.style.display = 'none';
                    toggleRulesBtn.textContent = 'View Current Rules and Fines';
                }
            });
        }

        // 3. Page specific load functions (userRole is now set or null)
        if (currentPageName === 'index.html' || currentPageName === 'pay_fine.html') {
            setupPublicHomePage();
        }
        if (currentPageName === 'helpdesk.html') {
            const grievanceForm = document.getElementById('grievance-form');
            if (grievanceForm) {
                grievanceForm.addEventListener('submit', submitGrievance);
            }
            const trackForm = document.getElementById('track-grievance-form');
            if (trackForm) {
                trackForm.addEventListener('submit', trackGrievanceStatus);
            }
        }
        if (currentPageName === 'superadmin_dashboard.html') {
            loadSuperAdminDashboard();
            
            // Setup Super Admin Staff Update Modal submission
            const updateStaffForm = document.getElementById('update-staff-form');
            if (updateStaffForm) {
                updateStaffForm.addEventListener('submit', updateStaffProfile);
            }
            
            const staffModal = document.getElementById('staff-update-modal');
            const closeModalBtn = document.querySelector('#staff-update-modal .close-btn');
            if (closeModalBtn) {
                closeModalBtn.onclick = () => {
                    if (staffModal) staffModal.style.display = 'none';
                }
            }
            
            // Setup Super Admin Search Form
            const searchForm = document.getElementById('superadmin-search-form');
            const clearBtn = document.getElementById('admin-clear-search-btn');
            if (searchForm) {
                 searchForm.addEventListener('submit', (e) => {
                     e.preventDefault();
                     const searchTerm = document.getElementById('admin-search-term').value.trim();
                     const statusFilter = document.getElementById('admin-search-status').value;
                     searchSuperAdminViolations(searchTerm, statusFilter);
                 });
            }
            if (clearBtn) {
                clearBtn.addEventListener('click', () => {
                     document.getElementById('admin-search-term').value = '';
                     document.getElementById('admin-search-status').value = 'all';
                     searchSuperAdminViolations();
                });
            }
            
            // Attach listener for the rule update modal submission (FIX: Fully implemented)
            const updateRuleForm = document.getElementById('update-rule-fine-form');
            const ruleModal = document.getElementById('rule-update-modal');
            if(updateRuleForm) {
                updateRuleForm.addEventListener('submit', (e) => {
                    e.preventDefault();
                    const ruleId = document.getElementById('update-rule-id').value;
                    const ruleName = document.getElementById('update-rule-name-display').textContent;
                    const newFine = document.getElementById('update-new-fine').value;
                    finalizeRuleFineUpdate(ruleId, ruleName, newFine);
                    // The function itself handles closing the modal on success
                });
                const ruleCloseBtn = document.querySelector('#rule-update-modal .close-btn');
                if(ruleCloseBtn) {
                     ruleCloseBtn.onclick = () => {
                         if (ruleModal) ruleModal.style.display = 'none';
                     }
                }
            }
            
            // Attach listener for Grievance Update Modal submission
            const updateGrievanceForm = document.getElementById('update-grievance-remark-form');
            if (updateGrievanceForm) {
                // IMPORTANT: Ensure the listener is attached to the form element
                updateGrievanceForm.addEventListener('submit', updateGrievanceRemark);
            }
            const grievanceModal = document.getElementById('grievance-remark-modal');
            const closeGrievanceBtn = document.querySelector('#grievance-remark-modal .close-btn');
            if (closeGrievanceBtn) {
                closeGrievanceBtn.onclick = () => {
                    if (grievanceModal) grievanceModal.style.display = 'none';
                }
            }
            
        }
        if (currentPageName === 'admin_dashboard.html') {
            loadAdminDashboard();
            
            // NEW: Setup TC Report Generator Listener
            const reportForm = document.getElementById('tc-report-form');
            if (reportForm) {
                // ATTACH THE NEWLY IMPLEMENTED FUNCTION HERE
                reportForm.addEventListener('submit', generateTCReport);
            }
            
            // TTE Management Form Setup (Listener attached only once via flag in function)
            const createTTEForm = document.getElementById('create-tte-form');
            if (createTTEForm && !hasTTEFormListener) {
                // FIX 1: createTTEAccount is now guaranteed to be defined globally
                createTTEForm.addEventListener('submit', createTTEAccount);
                hasTTEFormListener = true;
            }
            
            // TTE Update Modal Setup
            const updateTTEForm = document.getElementById('update-tte-form');
            if (updateTTEForm) {
                updateTTEForm.addEventListener('submit', updateTTEProfile);
            }

            const tteModal = document.getElementById('tte-update-modal');
            const closeModalBtn = document.querySelector('#tte-update-modal .close-btn');
            if (closeModalBtn) {
                closeModalBtn.onclick = () => {
                    if(tteModal) tteModal.style.display = 'none';
                }
            }
            window.onclick = function(event) {
                if (event.target == tteModal) {
                    tteModal.style.display = "none";
                }
            }
        }
        if (currentPageName === 'tte_dashboard.html') {
            loadTteDashboard(); 
            
            // Setup TTE Dashboard Search and All Records
            const searchForm = document.getElementById('tte-search-form');
            const viewAllBtn = document.getElementById('view-all-records-btn');
            
            if (searchForm) {
                 // Handle Search/Filter button
                 searchForm.addEventListener('submit', (e) => {
                     e.preventDefault();
                     const searchTerm = document.getElementById('search-term').value.trim();
                     const searchDate = document.getElementById('search-date').value.trim();
                     searchTteViolations(searchTerm, searchDate);
                 });
            }
            
            if (viewAllBtn) {
                // Handle View All Records button
                viewAllBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    // Clear inputs and search all
                    const searchTermInput = document.getElementById('search-term');
                    const searchDateInput = document.getElementById('search-date');
                    if (searchTermInput) searchTermInput.value = '';
                    if (searchDateInput) searchDateInput.value = '';
                    searchTteViolations('', '', true);
                });
            }
            
            // Initialize the passenger update modal
            setupPassengerUpdateModal();
        }
        if (currentPageName === 'add_violation.html') {
            setupViolationForm(); 
        }
        if (currentPageName === 'payment.html') {
            setupPaymentPage(); // Staff payment gateway (cash/upi/pay later)
            
            // Setup payment option buttons listeners
            const payCashBtn = document.getElementById('pay-cash');
            const payUpiBtn = document.getElementById('pay-upi');
            
            if (payCashBtn) {
                 payCashBtn.addEventListener('click', () => handlePaymentSelection('CASH', currentViolationData.isNewViolation, currentViolationData.hasUnpaid));
            }
            if (payUpiBtn) {
                 payUpiBtn.addEventListener('click', () => handlePaymentSelection('UPI', currentViolationData.isNewViolation, currentViolationData.hasUnpaid));
            }
        }
        if (currentPageName === 'passenger_payment_portal.html') {
            setupPassengerPaymentPortal(); // New public UPI-only payment portal
        }
        if (currentPageName === 'receipt.html') {
             setupReceiptPage(); // Dedicated receipt viewer
        }
    })();
});