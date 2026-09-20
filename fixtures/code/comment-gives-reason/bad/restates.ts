// Increment the counter
counter++;

// Loop over the users
for (const user of users) {
  notify(user);
}

// Set the title to the page name
document.title = pageName;

// Return true if the user is an admin
return user.role === "admin";

// Create a new array of lowercased tags
const lowercased = tags.map((tag) => tag.toLowerCase());

// Call the save function
save();
