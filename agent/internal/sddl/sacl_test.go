package sddl

import "testing"

func TestAuditACE(t *testing.T) {
	if got := AuditACE(true, false); got != "(AU;OICISAFA;0xd0156;;;WD)" {
		t.Fatalf("recursivo sem leitura: %s", got)
	}
	if got := AuditACE(false, true); got != "(AU;OINPSAFA;0xd0157;;;WD)" {
		t.Fatalf("só a pasta com leitura: %s", got)
	}
}

func TestParse(t *testing.T) {
	for _, c := range []struct {
		in    string
		flags string
		n     int
	}{
		{"", "", 0},
		{"S:", "", 0},
		{"S:AI", "AI", 0},
		{"O:BAG:SYD:(A;;FA;;;BA)S:PAI(AU;OICISA;FA;;;WD)(AU;CIIDFA;0x2;;;S-1-1-0)", "PAI", 2},
		// Entrada condicional com parênteses aninhados.
		{`S:(XU;SA;FA;;;WD;(@User.Dept == "RH"))(AU;SA;FW;;;WD)`, "", 2},
	} {
		s, err := Parse(c.in)
		if err != nil || s.Flags != c.flags || len(s.ACEs) != c.n {
			t.Errorf("Parse(%q) = %+v, %v", c.in, s, err)
		}
	}
	if _, err := Parse("S:(AU;SA;FA;;;WD"); err == nil {
		t.Error("parêntese aberto deveria dar erro")
	}
	s, _ := Parse("S:PAI")
	if !s.Protected() {
		t.Error("PAI é protegida")
	}
	s, _ = Parse("S:AI")
	if s.Protected() {
		t.Error("AI não é protegida")
	}
}

func TestWithWithout(t *testing.T) {
	ace := AuditACE(true, false)
	// Já existe outra entrada do cliente e uma herdada da pasta pai.
	s, _ := Parse("S:AI(AU;SA;FA;;;BA)(AU;OICIIDSA;FA;;;WD)")
	with, changed := s.With(ace)
	if !changed {
		t.Fatal("deveria acrescentar")
	}
	if got := with.String(); got != "S:AI(AU;SA;FA;;;BA)"+ace {
		t.Fatalf("With: %s (herdada some, a do cliente fica)", got)
	}
	if again, changed := with.With(ace); changed || again.String() != with.String() {
		t.Fatal("aplicar de novo não muda nada")
	}

	// O Windows pode escrever a mesma entrada com SID numérico e flags em outra ordem.
	same, _ := Parse("S:AI(AU;CIOIFASA;0xD0156;;;S-1-1-0)")
	if !same.Has(ace) {
		t.Fatal("entrada equivalente não reconhecida")
	}
	if same.Has(AuditACE(true, true)) {
		t.Fatal("máscara diferente não é a mesma entrada")
	}
	inherited, _ := Parse("S:AI(AU;OICIIDSAFA;0xd0156;;;WD)")
	if inherited.Has(ace) {
		t.Fatal("herdada não conta como aplicada nesta pasta")
	}

	without, changed := with.Without(ace)
	if !changed || without.String() != "S:AI(AU;SA;FA;;;BA)" {
		t.Fatalf("Without: %s %v", without, changed)
	}
	if _, changed := without.Without(ace); changed {
		t.Fatal("remover de novo não muda nada")
	}
}
