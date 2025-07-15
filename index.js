const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
require("dotenv").config();
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);
const admin = require("firebase-admin");
const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
const uri = process.env.MONGODB_URI;

const serviceAccount = require("./firebase-admin-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();
    const db = client.db("fastshiftDB"); // your DB name
    parcelCollection = db.collection("parcels");
    paymentsCollection = db.collection("payments");
    trackingsCollection = db.collection("trackings");
    usersCollection = db.collection("users");
    ridersCollection = db.collection("riders");

    // custom middleware //

    // verfy firebase token//

    const verifyFBToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).send({ message: "Unauthorized access" });
      }
      const token = authHeader.split(" ")[1];
      if (!token) {
        return res.status(401).send({ message: "Unauthorized access" });
      }

      //verify the token
      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        return res.status(403).send({ message: "Forbidden access" });
      }
    };

    // verify admin//

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      console.log(email);
      const query = { email };
      const user = await usersCollection.findOne(query);

      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "Forbidden access" });
      }
      next();
    };

    // verify Rider//

    const verifyRider = async (req, res, next) => {
      const email = req.decoded.email;
      console.log(email);
      const query = { email };
      const user = await usersCollection.findOne(query);

      if (!user || user.role !== "rider") {
        return res.status(403).send({ message: "Forbidden access" });
      }
      next();
    };

    // Your POST API to add a parcel
    app.post("/parcels", async (req, res) => {
      const parcelData = req.body;

      try {
        const result = await parcelCollection.insertOne(parcelData);
        res.status(201).send({
          success: true,
          message: "Parcel added successfully",
          insertedId: result.insertedId,
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: "Failed to add parcel",
          error: error.message,
        });
      }
    });

    // GET all parcels (no filter)
    app.get("/all-parcels", async (req, res) => {
      try {
        const parcels = await parcelCollection
          .find({})
          .sort({ created_at: -1 }) // Sort by latest
          .toArray();

        res.send({
          success: true,
          count: parcels.length,
          data: parcels,
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: "🚫 Failed to fetch all parcels",
          error: error.message,
        });
      }
    });

    app.get("/parcels/assignable", async (req, res) => {
      try {
        const query = {
          payment_status: "paid",
          delivery_status: "not_collected", // typo used in DB
        };

        const parcels = await parcelCollection.find(query).toArray();
        res.send(parcels);
      } catch (err) {
        console.error("Error fetching assignable parcels:", err);
        res.status(500).send({ message: "Internal Server Error" });
      }
    });

    // GET parcels by user email (latest first)
    app.get("/my-parcels", verifyFBToken, async (req, res) => {
      const userEmail = req.query.email;
      console.log("decoded", req.decoded);
      if (req.decoded.email !== userEmail) {
        return res.status(403).send({ message: "Forbidden access" });
      }
      if (!userEmail) {
        return res.status(400).send({
          success: false,
          message: "❌ Please provide an email query parameter",
        });
      }
      try {
        const parcels = await parcelCollection
          .find({ created_by: userEmail })
          .sort({ creation_date: -1 })
          .toArray();

        res.send({
          success: true,
          count: parcels.length,
          data: parcels,
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: "🚫 Failed to fetch parcels",
          error: error.message,
        });
      }
    });

    // get matched rieder to sender service center

    app.get("/riders/available", async (req, res) => {
      const { district } = req.query;

      try {
        const riders = await ridersCollection
          .find({ warehouse: district, status: "active" }) // ✅ Match with warehouse
          .toArray();

        res.send(riders);
      } catch (err) {
        console.error("Failed to fetch riders:", err);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    // asgin rider
    app.patch("/parcels/:id/assign", async (req, res) => {
      const { id } = req.params;
      const { riderId, riderName, riderEmail } = req.body;

      try {
        // 1. Update parcel
        const parcelResult = await parcelCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              assigned_rider_id: riderId,
              assigned_rider_email: riderEmail,
              assigned_rider_name: riderName,
              delivery_status: "rider_assigned", // ✅ Set to "in_transit"
              assigned_at: new Date().toISOString(),
            },
          }
        );
        // 2. Update rider's work_status
        const riderResult = await ridersCollection.updateOne(
          { _id: new ObjectId(riderId) },
          {
            $set: {
              work_status: "in_delivery", // ✅ Mark rider as busy
            },
          }
        );

        res.send({
          success: true,
          parcelModified: parcelResult.modifiedCount,
          riderModified: riderResult.modifiedCount,
        });
      } catch (error) {
        console.error("Assigning rider failed:", error);
        res
          .status(500)
          .send({ success: false, message: "Assignment failed", error });
      }
    });

    // GET: Get pending tasks for a specific rider
    app.get(
      "/parcels/rider-tasks",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        const riderEmail = req.query.email;

        if (!riderEmail) {
          return res.status(400).send({ message: "Rider email is required" });
        }

        try {
          const tasks = await parcelCollection
            .find({
              assigned_rider_email: riderEmail,
              delivery_status: { $in: ["rider_assigned", "in_transit"] },
            })
            .sort({ assigned_at: -1 }) // latest assigned tasks first
            .toArray();

          res.send(tasks);
        } catch (error) {
          console.error("Error fetching rider tasks:", error);
          res.status(500).send({ message: "Failed to fetch rider tasks" });
        }
      }
    );

    // Mark as Picked Up (status => in_transit)
    app.patch("/parcels/:id/picked-up", async (req, res) => {
      const { id } = req.params;
      const result = await parcelCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            delivery_status: "in_transit",
            picked_at: new Date(), // ✅ Track when picked up
          },
        }
      );
      res.send(result);
    });

    // Mark as Delivered (status => delivered)
    app.patch("/parcels/:id/delivered", async (req, res) => {
      const { id } = req.params;
      const result = await parcelCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            delivery_status: "delivered",
            delivered_at: new Date(), // ✅ Track when delivered
          },
        }
      );
      res.send(result);
    });

    // GET: Get completed deliveries for a specific rider
    app.get(
      "/parcels/rider-completed",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        const riderEmail = req.query.email;

        if (!riderEmail) {
          return res.status(400).send({ message: "Rider email is required" });
        }

        try {
          const completedParcels = await parcelCollection
            .find({
              assigned_rider_email: riderEmail,
              delivery_status: {
                $in: ["delivered", "service_center_delivered"],
              },
            })
            .sort({ assigned_at: -1 }) // latest first
            .toArray();

          res.send(completedParcels);
        } catch (error) {
          console.error("Error fetching completed parcels:", error);
          res
            .status(500)
            .send({ message: "Failed to fetch completed parcels" });
        }
      }
    );

    app.patch("/parcels/:id/cashout", async (req, res) => {
      const id = req.params.id;

      const result = await parcelCollection.updateOne(
        { _id: new ObjectId(id) }, // find parcel by ID
        {
          $set: {
            cashout_status: "cashed_out", // ✅ set new field
            cashed_out_at: new Date(), // ✅ add timestamp
          },
        }
      );

      res.send(result);
    });

    //tracking related apis/////

    // get trackings by id

    app.get("/trackings/:trackingId", async (req, res) => {
      const trackingId = req.params.trackingId;

      try {
        const updates = await trackingsCollection
          .find({ tracking_id: trackingId }) // 👈 must match the saved field
          .sort({ timestamp: 1 }) // oldest first
          .toArray();

        res.json(updates);
      } catch (err) {
        res.status(500).json({
          message: "Failed to fetch tracking updates",
          error: err.message,
        });
      }
    });

    // post trackings
    app.post("/trackings", async (req, res) => {
      const update = req.body;

      update.timestamp = new Date(); // Add timestamp
      if (!update.tracking_id || !update.status) {
        return res
          .status(400)
          .json({ message: "tracking_id and status are required." });
      }

      try {
        const result = await trackingsCollection.insertOne(update);
        res.status(201).json(result);
      } catch (err) {
        res.status(500).json({
          message: "Failed to save tracking update",
          error: err.message,
        });
      }
    });

    app.get("/parcels/delivery/status-count", async (req, res) => {
      const pipeline = [
        {
          $group: {
            _id: "$delivery_status",
            count: {
              $sum: 1,
            },
          },
        },
        {
          $project: {
            status: "$_id",
            count: 1,
            _id: 0,
          },
        },
      ];

      const result = await parcelCollection.aggregate(pipeline).toArray();
      res.send(result);
    });

    // GET single parcel by dynamic ID
    app.get("/all-parcels/:id", async (req, res) => {
      const parcelId = req.params.id;

      try {
        const parcel = await parcelCollection.findOne({
          _id: new ObjectId(parcelId),
        });

        if (!parcel) {
          return res.status(404).send({
            success: false,
            message: "❌ Parcel not found",
          });
        }

        res.send({
          success: true,
          data: parcel,
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: "🚫 Failed to fetch parcel",
          error: error.message,
        });
      }
    });

    // GET: Get payment history (by user email or all if no email)
    app.get("/payments", verifyFBToken, async (req, res) => {
      try {
        const userEmail = req.query.email;
        if (req.decoded.email !== userEmail) {
          return res.status(403).send({ message: "Forbidden access" });
        }
        const query = userEmail ? { created_by: userEmail } : {};
        const options = { sort: { paid_at: -1 } }; // Sort latest first

        const payments = await paymentsCollection
          .find(query, options)
          .toArray();

        res.send({
          success: true,
          count: payments.length,
          data: payments,
        });
      } catch (error) {
        console.error("Error fetching payment history:", error);
        res.status(500).send({
          success: false,
          message: "Failed to get payments",
          error: error.message,
        });
      }
    });

    // POST : post users

    app.post("/users", async (req, res) => {
      const email = req.body.email;
      const userExist = await usersCollection.findOne({ email });
      if (userExist) {
        // update last login
        await usersCollection.updateOne(
          { email },
          { $set: { last_logged_in: new Date().toISOString() } }
        );

        return res
          .status(200)
          .send({ message: "User already exist", inserted: false });
      }
      const user = req.body;
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    // POST: Mark parcel as paid + save payment history
    app.post("/payments", async (req, res) => {
      const { parcel_id, amount, transaction_id, created_by, payment_method } =
        req.body;

      if (!parcel_id || !amount || !transaction_id || !created_by) {
        return res
          .status(400)
          .send({ success: false, message: "Missing required fields" });
      }

      try {
        // 1. Update parcel payment_status
        const parcelUpdate = await parcelCollection.updateOne(
          { _id: new ObjectId(parcel_id) },
          { $set: { payment_status: "paid" } }
        );

        // 2. Save to payments collection
        const paymentDoc = {
          parcel_id: new ObjectId(parcel_id),
          amount,
          transaction_id,
          created_by,
          paid_at_string: new Date().toISOString(),
          paid_at: new Date(),
          payment_method,
        };

        const paymentResult = await paymentsCollection.insertOne(paymentDoc);

        res.send({
          success: true,
          message: "Payment recorded and parcel marked as paid",
          payment_id: paymentResult.insertedId,
        });
      } catch (err) {
        res.status(500).send({
          success: false,
          message: "Payment failed",
          error: err.message,
        });
      }
    });

    // post riders

    app.post("/riders", async (req, res) => {
      const rider = req.body;
      const result = await ridersCollection.insertOne(rider);
      res.send(result);
    });

    //get riders

    app.get("/riders/pending", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const pendingRiders = await ridersCollection
          .find({ status: "pending" })
          .toArray();
        res.send(pendingRiders);
      } catch (error) {
        console.error("Failed to get pending riders:", error.message);
        res.status(500).send({ message: "Failed to fetch pending riders" });
      }
    });

    // GET /riders/active
    app.get("/riders/active", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const activeRiders = await ridersCollection
          .find({ status: "active" })
          .toArray();
        res.send(activeRiders);
      } catch (error) {
        console.error("Error fetching active riders:", error);
        res.status(500).send({ message: "Internal Server Error" });
      }
    });

    // PATCH /riders/status/:id
    app.patch(
      "/riders/status/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const { status, email } = req.body;
        const result = await ridersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status } }
        );
        // update user role for accepting rider
        if (status === "active") {
          const userQuery = { email };
          const userUpdatedDoc = {
            $set: {
              role: "rider",
            },
          };
          const rolResult = await usersCollection.updateOne(
            userQuery,
            userUpdatedDoc
          );
          console.log(rolResult.modifiedCount);
        }

        res.send(result);
      }
    );

    // make user to admin //////////

    // GET: Search users by email or name
    app.get("/users/search", verifyFBToken, verifyAdmin, async (req, res) => {
      const query = req.query.q;

      if (!query) {
        return res.status(400).send({ message: "Search query is required" });
      }

      try {
        const users = await usersCollection
          .find({
            $or: [
              { email: { $regex: query, $options: "i" } },
              { name: { $regex: query, $options: "i" } },
            ],
          })
          .limit(10)
          .toArray();

        res.send(users);
      } catch (error) {
        res
          .status(500)
          .send({ message: "Failed to search users", error: error.message });
      }
    });

    // PATCH: Make user admin
    app.patch(
      "/users/make-admin/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;

        try {
          const result = await usersCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { role: "admin" } }
          );
          res.send(result);
        } catch (err) {
          res
            .status(500)
            .send({ message: "Failed to make admin", error: err.message });
        }
      }
    );

    // PATCH: Remove admin
    app.patch(
      "/users/remove-admin/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;

        try {
          const result = await usersCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { role: "user" } }
          );
          res.send(result);
        } catch (err) {
          res
            .status(500)
            .send({ message: "Failed to remove admin", error: err.message });
        }
      }
    );

    // role base get

    app.get("/users/:email/role", async (req, res) => {
      const email = req.params.email;

      try {
        const user = await usersCollection.findOne(
          { email },
          { projection: { role: 1, email: 1, created_at: 1 } }
        );

        if (!user) {
          return res.status(404).send({ message: "User not found" });
        }

        res.send(user);
      } catch (err) {
        console.error("Error fetching user role:", err);
        res
          .status(500)
          .send({ message: "Failed to get user role", error: err.message });
      }
    });

    // parcel indend

    app.post("/create-payment-intent", async (req, res) => {
      const amountInCents = req.body.amountInCents;
      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountInCents, // Amount in cents
          currency: "usd",
          payment_method_types: ["card"],
        });
        res.json({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // DELETE a parcel by ID
    app.delete("/parcels/:id", async (req, res) => {
      const parcelId = req.params.id;

      try {
        const result = await parcelCollection.deleteOne({
          _id: new ObjectId(parcelId),
        });

        if (result.deletedCount === 1) {
          res.send({
            success: true,
            message: "✅ Parcel deleted successfully",
            deletedCount: result.deletedCount,
          });
        } else {
          res.status(404).send({
            success: false,
            message: "❌ Parcel not found",
          });
        }
      } catch (error) {
        res.status(500).send({
          success: false,
          message: "🚫 Failed to delete parcel",
          error: error.message,
        });
      }
    });

    // Test GET
    app.get("/", (req, res) => {
      res.send("🚀 FastShift Server is Running");
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

// Routes
app.get("/", (req, res) => {
  res.send("FastShift server is running");
});

// Start Server
app.listen(port, () => {
  console.log(`FastShift server listening at port ${port}`);
});
