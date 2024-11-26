import express from "express";
import session from "express-session";
import { getEmbedding } from './get-embeddings.js';
import { MongoClient, ObjectId } from "mongodb";
import flash from 'connect-flash';
import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import bcrypt from "bcryptjs";
import MongoStore from "connect-mongo";
import methodOverride from "method-override";

// Initialize env
const app = express();

// MongoDB connection URI and options
const ATLAS_CONNECTION_STRING = "mongodb+srv://cklkslee:0400@lab2cluster.elg1k.mongodb.net/?retryWrites=true&w=majority&appName=Lab2Cluster";
const SESSION_SECRET = "your_session_secret";

const userClient = new MongoClient(ATLAS_CONNECTION_STRING);
const movieClient = new MongoClient(ATLAS_CONNECTION_STRING);

const userDb = userClient.db("user_management");
const usersCollection = userDb.collection("users");
const movieDb = movieClient.db("sample_mflix");
const moviesCollection = movieDb.collection("movies");
const userFavoritesCollection = userDb.collection("favorites");

await userClient.connect();
await movieClient.connect();

// Loading middlewares
app.set("view engine", "ejs");
app.use(methodOverride("_method"));
app.use(express.static('public'));
app.use(express.urlencoded({ extended: false })); 
app.use(express.json());
app.use(flash());
app.use(express.static('public'));
app.use(
    session({
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        store: MongoStore.create({
            clientPromise: userClient.connect(),
            dbName: "user_management",
        }),
    })
);
app.use(passport.initialize());
app.use(passport.session());

// Passport initialization
passport.use(
    new LocalStrategy({ usernameField: "email" }, async (email, password, done) => {
        try {
            const user = await usersCollection.findOne({ email });

            if (!user) {
                return done(null, false, { message: "Email not registered" });
            }

            const isMatch = await bcrypt.compare(password, user.password);
            if (!isMatch) {
                return done(null, false, { message: "Password Error" });
            }

            return done(null, user);
        } catch (error) {
            return done(error);
        }
    })
);

passport.serializeUser((user, done) => {
    done(null, user._id);
});

passport.deserializeUser(async (id, done) => {
    try {
        const user = await usersCollection.findOne({ _id: new ObjectId(id) });
        done(null, user);
    } catch (error) {
        done(error);
    }
});

// Authentication functions
const ensureAuthenticated = (req, res, next) => {
    console.log("Checking authentication")
    console.log("IS authentication:", req.isAuthenticated());
    if (req.isAuthenticated()) {
        return next();
    }
    res.redirect("/login");
};

const ensureAdmin = (req, res, next) => {
    if (req.isAuthenticated() && req.user.role === "admin") {
        return next();
    }
    res.redirect("/login");
};

// Handler functions 
const searchByPlot = async (req, res) => {
    try {
        // Connect to the MongoDB client
        // await movieClient.connect();

        // // Specify the database and collection
        const db = movieClient.db("sample_mflix");
        const collection = db.collection("movies");

        // Generate embedding for the search query
        const queryEmbedding = await getEmbedding(req.query.queryStr);

        // Define the sample vector search pipeline
        const pipeline = [
            {
                $vectorSearch: {
                    index: "vector_index",
                    queryVector: queryEmbedding,
                    path: "embedding",
                    exact: true,
                    limit: 10
                }
            },
            {
                $project: {
                    embedding: 0,
                    score: {
                        $meta: "vectorSearchScore"
                    }
                }
            }
        ];

        // run pipeline
        const results = await collection.aggregate(pipeline).toArray();

        const userFav = await userFavoritesCollection.find({userId: req.user._id}).toArray();
        // console.log(userFav);

        // send results
        res.status(200).render('resultByPlots', {movies: results, userFav: userFav[0], user: req.user, req: req, error: null});
    } catch (error) {
        console.error("Error in searchByPlot:", error);
        res.render("resultByPlots", {
            movies: [],
            userFav: [], 
            user: req.user, 
            req: req,
            error: "An error occurred while searching for movies.",
        })
    }
}

// Routing

// User registration
app.get("/register", (req, res) => {
    res.render("userSignup", { error: null });
});

app.post("/register", async (req, res) => {
    const { email, username, password, confirmPassword } = req.body;

    if (!email || !username || !password || !confirmPassword) {
        return res.render("userSignup", { error: "All fields are required" });
    }

    if (password !== confirmPassword) {
        return res.render("userSignup", { error: "The password is different from the confirmation password" });
    }

    const existingUser = await usersCollection.findOne({ email });
    if (existingUser) {
        return res.render("userSignup", { error: "The email address has been registered" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await usersCollection.insertOne({ email, username, password: hashedPassword, role: "user" });

    res.redirect("/login");
});

// User login
app.get("/login", (req, res) => {
    const error = req.flash("error");
    res.render("login", { error: null });
});

app.post(
    "/login",
    passport.authenticate("local", {
        failureRedirect: "/login",
        failureFlash: true,
    }),
    (req, res) => {
        // Redirect to stored path or a role-specific path
        const redirectTo = req.session.returnTo || (req.user.role === "admin" ? "/admin" : "/");
        delete req.session.returnTo; // Clear the session variable
        res.redirect(redirectTo);
    }
);

app.get("/logout", (req, res) => {
    req.logout(err => {
        if (err) {
            console.error("Logout error:", err);
            return res.redirect("/");
        }
        req.session.destroy(() => {
            res.redirect("/");
        });
    });
});

// // User dashboard
// app.get("/user-dashboard", ensureAuthenticated, async (req, res) => {
//     res.render("user-dashboard", { user: req.user, movies: [], error: null });
// });

// Favorite movies (users only)
app.post("/favorites", ensureAuthenticated, async (req, res) => {
    try {
        // console.log(req.body.movieId); 
        const movieId  = req.body.movieId; 

        if (!movieId) {
            return res.status(400).send({ error: "Movie ID is required" });
        }

        const existingMovie = await moviesCollection.findOne({ _id: new ObjectId(movieId) });
        if (!existingMovie) {
            return res.status(404).send({ error: "Movie not found" });
        }

        await userFavoritesCollection.updateOne(
            { userId: req.user._id }, 
            { $addToSet: { favorites: new ObjectId(movieId) } }, 
            { upsert: true } 
        );

        const redirectUrl = req.get('referer') || '/';
        res.redirect(redirectUrl);

    } catch (error) {
        console.error("Error in addFavorite:", error);
        res.status(500).send({ error: "Internal Server Error" });
    }
});

//Delete Favorites (User only)
app.post("/favorites/:movieId", ensureAuthenticated, async (req, res) => {
    const { action } = req.query;

    if (action === "delete") {
        const { movieId } = req.params;

        if (!ObjectId.isValid(movieId)) {
            return res.status(400).send({ error: "Invalid Movie ID" });
        }

        try {
            await userFavoritesCollection.updateOne(
                { userId: req.user._id },
                { $pull: { favorites: new ObjectId(movieId) } }
            );

            res.redirect("/user/favorites");
        } catch (error) {
            console.error("Error in removeFavorite:", error);
            res.status(500).send({ error: "Internal Server Error" });
        }
    } else {
        res.status(400).send({ error: "Unsupported action or missing action parameter" });
    }
});


//Render favorites
app.get("/user/favorites", ensureAuthenticated, async (req, res) => {
    try {
        const userFavorites = await userFavoritesCollection.findOne({ userId: req.user._id });
        const favoriteMovieIds = userFavorites ? userFavorites.favorites : [];

        const favorites = await moviesCollection
            .find({ _id: { $in: favoriteMovieIds } })
            .toArray();

        res.render("favorites", { favorites, user: req.user, req}); 
    } catch (error) {
        console.error("Error fetching favorites:", error);
        res.status(500).send("Internal Server Error");
    }
});

//Profile edit
app.post("/profile/edit", ensureAuthenticated, async (req, res) => {
    const { username, currentPassword, newPassword, confirmNewPassword } = req.body;

    if (!currentPassword) {
        return res.render("UsereditProfile", {
            user: req.user,
            error: "Current password is required to update your profile",
        });
    }

    const user = await usersCollection.findOne({ _id: new ObjectId(req.user._id) });
    const isPasswordCorrect = await bcrypt.compare(currentPassword, user.password);
    if (!isPasswordCorrect) {
        return res.render("UsereditProfile", {
            user: req.user,
            error: "Current password is incorrect",
        });
    }

    if (!username && !newPassword) {
        return res.render("UsereditProfile", {
            user: req.user,
            error: "You must provide at least a new username or a new password",
        });
    }

    if (newPassword && newPassword !== confirmNewPassword) {
        return res.render("UsereditProfile", {
            user: req.user,
            error: "New password and confirmation password do not match",
        });
    }

    const updates = {};
    if (username && username !== req.user.username) {
        updates.username = username;
    }
    if (newPassword) {
        updates.password = await bcrypt.hash(newPassword, 10);
    }

    if (Object.keys(updates).length === 0) {
        return res.render("UsereditProfile", {
            user: req.user,
            error: "No changes detected in the profile",
        });
    }

    await usersCollection.updateOne({ _id: new ObjectId(req.user._id) }, { $set: updates });

    const updatedUser = await usersCollection.findOne({ _id: new ObjectId(req.user._id) });
    req.login(updatedUser, (err) => {
        if (err) {
            return res.render("UsereditProfile", {
                user: req.user,
                error: "Profile updated, but an error occurred during session refresh",
            });
        }
        res.render("UsereditProfile", {
            user: updatedUser,
            error: "Profile updated successfully!",
        });
    });
});

app.get("/profile/edit", ensureAuthenticated, (req, res) => {
    res.render("UsereditProfile", {
        user: req.user,
        error: null,
    });
});


app.get('/', (req,res) => {
    res.status(200).render('home', {user: req.user, req: req});
})

app.get('/search', (req,res) => {
    searchByPlot(req, res);
})

app.get('/admin', (req,res) => {
    res.status(200).render('admin');
})

const PORT = process.env.PORT || 8099;
const server = app.listen(PORT, () => {
    console.log(`The server runs on http://localhost:${PORT}`)
});

process.on("SIGINT", async () => {
    console.log("Closing MongoDB connections...");
    await userClient.close();
    await movieClient.close();
    server.close(() => {
        console.log("Server shut down");
        process.exit(0);
    });
});
