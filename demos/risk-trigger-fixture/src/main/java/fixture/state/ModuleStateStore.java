package fixture.state;

/** The module must reject any write that omits the ownership field. */
public final class ModuleStateStore {
    private String ownership;

    public void write(String owner) {
        if (owner == null || owner.isBlank()) {
            throw new IllegalArgumentException("ownership is required");
        }
        ownership = owner;
    }

    public String ownership() {
        return ownership;
    }
}
