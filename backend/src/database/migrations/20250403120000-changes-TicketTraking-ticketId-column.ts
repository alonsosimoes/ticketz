import { QueryInterface, DataTypes } from "sequelize";

module.exports = {
  up: async (queryInterface: QueryInterface) => {
    await queryInterface.addConstraint("TicketTraking", {
      fields: ["ticketId"],
      type: "unique",
      name: "ticketId_unique_constraint"
    });
  },

  down: async (queryInterface: QueryInterface) => {
    await queryInterface.removeConstraint("TicketTraking", "ticketId_unique_constraint");
  }
};